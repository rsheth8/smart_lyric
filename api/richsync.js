// Vercel proxy for Musixmatch "richsync" word-level lyrics. The reverse-engineered
// desktop-app token flow needs a server-side call (no CORS + a secret-ish token),
// so it runs here. Mirrors the /api/richsync route in server.mjs. Soft-fails so the
// client falls through to line-level providers. NOTE: Musixmatch's token endpoint
// captcha-blocks datacenter IPs (Vercel), so this is most reliable from the
// long-running Electron main process (a residential IP); on Vercel it often returns
// empty and the chain falls back to LRCLIB.

import { fetchMusixmatchRichsync } from '../lib/musixmatch.mjs';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const { artist = '', track = '' } = req.query || {};
  if (!track) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'track is required' }));
    return;
  }

  try {
    const result = await fetchMusixmatchRichsync({ artist: String(artist), track: String(track) });
    res.statusCode = 200;
    res.end(JSON.stringify(result || { richsync: '', meta: null }));
  } catch (err) {
    res.statusCode = 200; // soft-fail
    res.end(JSON.stringify({ richsync: '', meta: null, error: String(err?.message || err) }));
  }
}
