// Word-level Musixmatch proxy. Prefer the official key when present; otherwise
// the desktop-token fallback. Grow forbids storing licensed lyrics, so this
// route never sets a cache lifetime.

import { fetchMusixmatchRichsync } from '../lib/musixmatch.mjs';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const track = String(q.track || '');
  const isrc = String(q.isrc || '');
  const spotifyID = String(q.spotifyID || q.spotifyId || '');
  const appleMusicID = String(q.appleMusicID || q.appleMusicId || '');
  if (!track && !isrc && !spotifyID && !appleMusicID) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'track or recording id is required' }));
    return;
  }

  try {
    const result = await fetchMusixmatchRichsync({
      artist: String(q.artist || ''),
      track,
      isrc,
      spotifyID,
      appleMusicID,
      duration: q.duration,
    });
    res.statusCode = 200;
    res.end(JSON.stringify(result || { richsync: '', meta: null }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ richsync: '', meta: null, error: String(err?.message || err) }));
  }
}
