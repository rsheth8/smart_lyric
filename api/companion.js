// Hosted companion relay (phone ⇄ TV) — the Vercel twin of the LAN relay in
// server.mjs, with the same API (protocol: app/companion.js).
//
// Serverless instances share no memory, so messages go through Upstash Redis
// (provisioned via the Vercel Marketplace: KV_REST_API_URL / KV_REST_API_TOKEN):
// a POST pushes onto the receiving role's list, and the SSE stream drains that
// list on a short, idle-backed-off poll. Plain REST over fetch — no SDK.
//
// ponytail: polling, not pub/sub — ~1-4 Redis commands/sec per open stream.
// Fine for a living room; move to Upstash's SSE subscribe (or WebSockets on
// Fluid) if usage outgrows the Redis plan.

import { ROOM_RE, ROLES, MAX_MESSAGE_BYTES } from '../app/companion.js';

const STREAM_MS = 240_000; // under the function timeout; EventSource reconnects
const POLL_FAST_MS = 250;
const POLL_IDLE_MS = 1500;
const TTL_S = 120; // messages for a peer that never shows up expire
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function redis(commands) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json(); // [{ result } | { error }]
}

export async function readBody(req) {
  if (typeof req.body === 'string') return req.body; // runtime already buffered text/plain
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_MESSAGE_BYTES) break;
  }
  return body;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const q = new URL(req.url, 'http://relay').searchParams;
  const room = q.get('room') || '';
  const role = q.get('role');
  if (!ROOM_RE.test(room) || !ROLES.includes(role)) {
    res.statusCode = 400;
    res.end();
    return;
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body.length > MAX_MESSAGE_BYTES) {
      res.statusCode = 413;
      res.end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const key = `companion:${room}:${role === 'tv' ? 'phone' : 'tv'}`;
    try {
      // Re-serialised, so an untrusted body can't smuggle newlines into the SSE frame.
      await redis([['RPUSH', key, JSON.stringify(msg)], ['LTRIM', key, -100, -1], ['EXPIRE', key, TTL_S]]);
      res.statusCode = 204;
    } catch {
      res.statusCode = 502;
    }
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end();
    return;
  }

  const key = `companion:${room}:${role}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.write(': open\n\n');

  let open = true;
  req.on('close', () => { open = false; });
  const until = Date.now() + STREAM_MS;
  let delay = POLL_FAST_MS;
  let lastPing = Date.now();
  while (open && Date.now() < until) {
    let got = false;
    try {
      const [{ result }] = await redis([['LPOP', key, 20]]);
      for (const m of result || []) res.write(`data: ${m}\n\n`);
      got = !!result?.length;
    } catch {
      /* transient Redis hiccup — keep polling */
    }
    delay = got ? POLL_FAST_MS : Math.min(delay * 1.5, POLL_IDLE_MS);
    if (Date.now() - lastPing > 20_000) {
      res.write(': ping\n\n');
      lastPing = Date.now();
    }
    await sleep(delay);
  }
  res.end();
}
