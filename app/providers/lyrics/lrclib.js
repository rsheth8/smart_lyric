// LRCLIB synced-lyrics provider (https://lrclib.net).

const BASE = 'https://lrclib.net/api';
const TIMEOUT_MS = 10000;

const timedFetch = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

export function normalizeTitle(s) {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bem\b/gi, 'them')
    .replace(/\bcuz\b/gi, 'because')
    .replace(/\btil\b/gi, 'till')
    .replace(/\bout\b/gi, 'about');
}

function canonicalTitle(s) {
  return normalizeTitle(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleScore(query, candidate) {
  const q = canonicalTitle(query);
  const c = canonicalTitle(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1;
  if (c.includes(q) || q.includes(c)) return 0.85;
  const qw = new Set(q.split(' '));
  const cw = c.split(' ');
  const overlap = cw.filter((w) => qw.has(w)).length;
  return overlap / Math.max(qw.size, cw.length);
}

export function pickBestMatch(list, { artist, track }, minScore = 0.5) {
  let hits = (list || []).filter((x) => x.syncedLyrics);
  if (!hits.length) return null;

  if (artist) {
    const a = artist.toLowerCase();
    const byArtist = hits.filter((x) => (x.artistName || '').toLowerCase().includes(a));
    if (byArtist.length) hits = byArtist;
  }

  hits.sort((x, y) => titleScore(track, y.trackName) - titleScore(track, x.trackName));
  const best = hits[0];
  return titleScore(track, best.trackName) >= minScore ? best : null;
}

function toResult(hit) {
  return hit
    ? {
        lrc: hit.syncedLyrics,
        format: 'lrc',
        meta: {
          trackName: hit.trackName,
          artistName: hit.artistName,
          albumName: hit.albumName,
          duration: hit.duration,
        },
        source: 'lrclib',
      }
    : null;
}

async function fetchSearch(params) {
  const res = await timedFetch(`${BASE}/search?${params}`);
  if (!res.ok) return [];
  return res.json();
}

export async function search({ artist, track }) {
  const ctx = { artist, track };
  const variants = [...new Set([track, normalizeTitle(track)].filter(Boolean))];

  for (const name of variants) {
    const params = new URLSearchParams({ track_name: name });
    if (artist) params.set('artist_name', artist);
    const list = await fetchSearch(params);
    const hit = pickBestMatch(list, ctx);
    if (hit) return toResult(hit);
  }

  const firstWord = track.trim().split(/\s+/)[0];
  if (firstWord && artist && firstWord.length >= 3) {
    const params = new URLSearchParams({ track_name: firstWord, artist_name: artist });
    const list = await fetchSearch(params);
    const hit = pickBestMatch(list, ctx);
    if (hit) return toResult(hit);
  }

  return null;
}

export async function fetchFromLRCLIB({ artist, track, album, duration }) {
  const params = new URLSearchParams({ track_name: track });
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  if (duration) params.set('duration', String(Math.round(duration)));

  try {
    const res = await timedFetch(`${BASE}/get?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics) return { lrc: data.syncedLyrics, format: 'lrc', meta: data, source: 'lrclib' };
    }
  } catch {
    /* fall through */
  }
  return search({ artist, track });
}
