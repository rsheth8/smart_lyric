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

import { ROOM_RE, ROLES, PEER_RE, MAX_MESSAGE_BYTES } from '../app/companion.js';

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
    // Re-serialised, so an untrusted body can't smuggle newlines into the SSE frame.
    const data = JSON.stringify(msg);
    const keys = [`companion:${room}:${role === 'tv' ? 'phone' : 'tv'}`];
    try {
      if (role === 'tv') {
        // Fan out to every registered guest phone (the shared list above still
        // serves a phone page from before guest rooms, which sends no peer id).
        const [{ result: peers = [] }] = await redis([['SMEMBERS', `companion:${room}:phones`]]);
        for (const p of peers) keys.push(`companion:${room}:phone:${p}`);
      }
      await redis(keys.flatMap((k) => [['RPUSH', k, data], ['LTRIM', k, -100, -1], ['EXPIRE', k, TTL_S]]));
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

  // Each guest phone drains its own list: with one shared list, LPOP would hand
  // every TV update to whichever phone polled first and starve the rest.
  const peer = role === 'phone' && PEER_RE.test(q.get('peer') || '') ? q.get('peer') : null;
  const key = peer ? `companion:${room}:phone:${peer}` : `companion:${room}:${role}`;
  const phonesKey = `companion:${room}:phones`;
  // ponytail: a phone whose function dies without cleanup lingers in the set until
  // its TTL lapses, costing a few wasted RPUSHes per TV update; bounded by TTL_S.
  const register = () =>
    peer ? redis([['SADD', phonesKey, peer], ['EXPIRE', phonesKey, TTL_S]]).catch(() => {}) : null;
  await register();
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
      register(); // keep this phone's membership alive past TTL_S
    }
    await sleep(delay);
  }
  // Phone left for good (not just this stream's time limit, where EventSource
  // reconnects straight away and re-registers).
  if (peer && !open) await redis([['SREM', phonesKey, peer]]).catch(() => {});
  res.end();
}
