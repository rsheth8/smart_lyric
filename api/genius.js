// Vercel proxy for plain lyrics via Genius (token + page scrape stay server-side).
// Mirrors the /api/genius route in server.mjs. Soft-fails so the client can move
// on. Requires GENIUS_ACCESS_TOKEN in the Vercel env; skipped without it.

import { fetchGeniusLyrics } from '../lib/genius.mjs';

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
    const result = await fetchGeniusLyrics({ artist: String(artist), track: String(track) });
    res.statusCode = 200;
    res.end(JSON.stringify(result || { plain: '', meta: null }));
  } catch (err) {
    res.statusCode = 200; // soft-fail
    res.end(JSON.stringify({ plain: '', meta: null, error: String(err?.message || err) }));
  }
}
