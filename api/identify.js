// Ambient song recognition for clients that can't hold a secret — the Apple TV
// app posts a few seconds of room audio here and gets back what's playing and
// how far into it the room is.
//
// The ACRCloud credentials stay on the server. An app bundle is readable, so the
// tvOS app never sees them.
//
// POST body: raw WAV bytes (Content-Type: audio/wav).
// 200 {match: {...}} on a hit, 200 {match: null} on a clean miss, 503 when the
// service isn't configured, 502 when it errors. A miss is not an error — the
// detector counts misses to decide the song ended.

import { identify, acrConfigured } from '../lib/acrcloud.mjs';

// A listen chunk is a few seconds of mono 16k WAV (~160 KB). Anything much bigger
// is a mistake or an abuse, and every call costs money.
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;

async function readBytes(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_SAMPLE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'POST a WAV sample' }));
    return;
  }
  if (!acrConfigured()) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'recognition not configured' }));
    return;
  }

  const wav = await readBytes(req);
  if (!wav || wav.length === 0) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: `sample must be 1..${MAX_SAMPLE_BYTES} bytes` }));
    return;
  }

  try {
    const match = await identify(wav);
    res.statusCode = 200;
    res.end(JSON.stringify({ match }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}
