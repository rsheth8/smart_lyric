// Node-side NetEase Cloud Music lyrics fetcher (word-level "yrc" when available).
// Shared by the local dev server, the Vercel proxy, and the Electron main process
// so the same search/fetch logic runs everywhere. Browsers can't call NetEase
// directly (no CORS header), so this always runs server-side / in main.

const BASE = 'https://music.163.com/api';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com' };
const TIMEOUT_MS = 8000;

function timedFetch(url) {
  return fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function canonical(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cheap title similarity so we don't grab a remix/cover when an exact match exists.
export function scoreTitle(query, candidate) {
  const q = canonical(query);
  const c = canonical(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1;
  if (c.includes(q) || q.includes(c)) return 0.85;
  const qw = new Set(q.split(' '));
  const cw = c.split(' ');
  const overlap = cw.filter((w) => qw.has(w)).length;
  return overlap / Math.max(qw.size, cw.length);
}

// 1 when the lengths agree, decaying to 0 by ~12s off; null when either is unknown.
// NetEase song.duration is milliseconds; the caller's `duration` is seconds.
function durationBonus(targetSec, songMs) {
  const a = Number(targetSec);
  const b = Number(songMs) / 1000;
  if (!a || !b || a <= 0 || b <= 0) return null;
  const off = Math.abs(a - b);
  if (off <= 2.5) return 1;
  if (off >= 12) return 0;
  return 1 - (off - 2.5) / (12 - 2.5);
}

async function searchSongId({ artist, track, duration }) {
  const q = [track, artist].filter(Boolean).join(' ');
  const params = new URLSearchParams({ s: q, type: '1', limit: '10' });
  const res = await timedFetch(`${BASE}/search/get?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  const songs = data?.result?.songs || [];
  if (!songs.length) return null;

  const a = canonical(artist);
  let best = null;
  let bestScore = -1;
  for (const s of songs) {
    const artists = (s.artists || []).map((x) => canonical(x.name));
    const artistOk = !a || artists.some((x) => x.includes(a) || a.includes(x));
    // Length agreement breaks ties between same-titled takes (album / live / remix)
    // and pulls up the right recording; it only nudges (±0.4) so a strong title
    // still wins, and contributes nothing when the caller has no duration.
    const dur = durationBonus(duration, s.duration);
    const score =
      scoreTitle(track, s.name) + (artistOk ? 0.5 : 0) + (dur === null ? 0 : 0.4 * (dur - 0.5));
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // Require at least a decent title match to avoid wildly wrong songs.
  return best && scoreTitle(track, best.name) >= 0.5 ? best : null;
}

/**
 * Search NetEase and fetch lyrics for a track.
 * @returns {Promise<{ yrc: string, lrc: string, meta: object }|null>}
 *   `yrc` is word-level (may be empty); `lrc` is line-level.
 */
export async function fetchNeteaseLyrics({ artist, track, duration }) {
  if (!track) return null;
  const song = await searchSongId({ artist, track, duration });
  if (!song) return null;

  // lv=lyric, yv=word-level yrc, rv=romanization, tv=translation (usually Chinese).
  const params = new URLSearchParams({ id: String(song.id), lv: '0', yv: '0', rv: '0', tv: '0' });
  const res = await timedFetch(`${BASE}/song/lyric/v1?${params}`);
  if (!res.ok) return null;
  const data = await res.json();

  const yrc = data?.yrc?.lyric || '';
  const lrc = data?.lrc?.lyric || '';
  // Romanized (Latin-letter) pronunciation — same timestamps as `lrc`. This is the
  // "sing-along" overlay for Japanese/Korean/Chinese. `tlrc` is NetEase's own
  // translation but it's almost always Chinese, so we don't use it for English.
  const rlrc = data?.romalrc?.lyric || '';
  const tlrc = data?.tlyric?.lyric || '';
  if (!yrc && !lrc) return null;

  return {
    yrc,
    lrc,
    rlrc,
    tlrc,
    meta: {
      trackName: song.name,
      artistName: (song.artists || []).map((x) => x.name).join(', '),
      albumName: song.album?.name,
      duration: song.duration ? song.duration / 1000 : undefined, // seconds, for match validation
      neteaseId: song.id,
    },
  };
}
