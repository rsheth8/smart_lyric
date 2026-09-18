import { readTimings } from '../lib/word-timings.mjs';
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method && req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Read-only endpoint.' }));
    return;
  }
  try {
    const { artist = '', track = '', duration = '' } = req.query || {};
    const { spotifyID, appleMusicID, isrc, explicit } = req.query || {};
    if ([spotifyID, appleMusicID, isrc].some(value => value != null && (typeof value !== 'string' || !value.trim() || value.length > 128))
      || (explicit != null && !['true', 'false'].includes(explicit))
      || (isrc && !spotifyID && !appleMusicID && explicit == null)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid recording identity.' }));
      return;
    }
    const recording = spotifyID || appleMusicID || isrc
      ? { spotifyID, appleMusicID, isrc, explicit: explicit == null ? undefined : explicit === 'true' } : undefined;
    const result = await readTimings({ artist: String(artist), track: String(track), duration: Number(duration), recording });
    res.statusCode = 200;
    res.end(JSON.stringify(result ?? { timeline: null }));
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'Prepared word timings are temporarily unavailable.' }));
  }
}
