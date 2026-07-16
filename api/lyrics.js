// Vercel proxy for word-level lyrics (NetEase). The browser can't call NetEase
// directly (no CORS), so it calls this same-origin endpoint instead.
// Mirrors the /api/lyrics route in server.mjs (local dev).

import { fetchNeteaseLyrics } from '../lib/netease.mjs';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const { artist = '', track = '', duration = '' } = req.query || {};
  if (!track) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'track is required' }));
    return;
  }

  try {
    const result = await fetchNeteaseLyrics({
      artist: String(artist),
      track: String(track),
      duration: Number(duration) || undefined,
    });
    res.statusCode = 200;
    res.end(JSON.stringify(result || { yrc: '', lrc: '', meta: null }));
  } catch (err) {
    res.statusCode = 200; // soft-fail: let the client fall through to LRCLIB
    res.end(JSON.stringify({ yrc: '', lrc: '', meta: null, error: String(err?.message || err) }));
  }
}
