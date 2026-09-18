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

// Search credits separately from the title. Keep remix/live/version labels:
// those can identify a different recording and must not be normalized away.
export function searchTitle(title) {
  return String(title || '')
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .replace(/\s+/g, ' ').trim();
}

async function searchSongs({ artist, track, duration }) {
  const leadArtist = String(artist || '').split(',')[0]
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '').trim();
  const title = searchTitle(track);
  const q = [title, leadArtist].filter(Boolean).join(' ');
  const params = new URLSearchParams({ s: q, type: '1', limit: '10' });
  const res = await timedFetch(`${BASE}/search/get?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const songs = data?.result?.songs || [];
  if (!songs.length) return [];

  const a = canonical(leadArtist);
  const ranked = [];
  for (const s of songs) {
    const artists = (s.artists || []).map((x) => canonical(x.name));
    const artistOk = !a || artists.some((x) => x && (x.includes(a) || a.includes(x)));
    if (!artistOk) continue;
    // Align with the TV's gross recording-duration rejection.
    if (Number(duration) > 0 && s.duration > 0
        && Math.abs(Number(duration) - s.duration / 1000) >= 22) continue;
    // Length agreement breaks ties between same-titled takes (album / live / remix)
    // and pulls up the right recording; it only nudges (±0.4) so a strong title
    // still wins, and contributes nothing when the caller has no duration.
    const dur = durationBonus(duration, s.duration);
    const score =
      scoreTitle(title, searchTitle(s.name)) + 0.5 + (dur === null ? 0 : 0.4 * (dur - 0.5));
    if (scoreTitle(title, searchTitle(s.name)) >= 0.5) ranked.push({ song: s, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0]?.song;
  if (!best) return [];
  const credits = s => (s.artists || []).map(a => canonical(a.name)).sort().join('|');
  // The same recording may be listed on a single, album, and compilation, with
  // word timing attached to only one. Inspect at most three close equivalents.
  // Keep alternate edits/guest lineups out of this fallback candidate pool.
  const alternatives = ranked.slice(1).map(r => r.song).filter(s =>
    s.id !== best.id && canonical(searchTitle(s.name)) === canonical(searchTitle(best.name))
    && credits(s) === credits(best) && Number(duration) > 0 && s.duration > 0
    && Math.abs(s.duration / 1000 - Number(duration)) <= 2.5
    && Math.abs(s.duration - best.duration) <= 2500);
  return [best, ...alternatives.slice(0, 2)];
}

/**
 * Search NetEase and fetch lyrics for a track.
 * @returns {Promise<{ yrc: string, lrc: string, meta: object }|null>}
 *   `yrc` is word-level (may be empty); `lrc` is line-level.
 */
export async function fetchNeteaseLyrics({ artist, track, duration }) {
  if (!track) return null;
  const songs = await searchSongs({ artist, track, duration });
  const settled = await Promise.allSettled(songs.map(fetchSongLyrics));
  const results = settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(Boolean);
  return results.find(r => r.yrc) ?? results[0] ?? null;
}

async function fetchSongLyrics(song) {
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
