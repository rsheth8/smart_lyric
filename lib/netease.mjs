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

async function searchSongId({ artist, track }) {
  const q = [track, artist].filter(Boolean).join(' ');
  const params = new URLSearchParams({ s: q, type: '1', limit: '5' });
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
    const score = scoreTitle(track, s.name) + (artistOk ? 0.5 : 0);
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
export async function fetchNeteaseLyrics({ artist, track }) {
  if (!track) return null;
  const song = await searchSongId({ artist, track });
  if (!song) return null;

  const params = new URLSearchParams({ id: String(song.id), lv: '0', yv: '0', tv: '0' });
  const res = await timedFetch(`${BASE}/song/lyric/v1?${params}`);
  if (!res.ok) return null;
  const data = await res.json();

  const yrc = data?.yrc?.lyric || '';
  const lrc = data?.lrc?.lyric || '';
  if (!yrc && !lrc) return null;

  return {
    yrc,
    lrc,
    meta: {
      trackName: song.name,
      artistName: (song.artists || []).map((x) => x.name).join(', '),
      albumName: song.album?.name,
      neteaseId: song.id,
    },
  };
}
