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

/** Strip Spotify/iTunes noise so "Song (feat. X) - Remastered" still matches LRCLIB. */
export function cleanTrackTitle(s) {
  return normalizeTitle(s || '')
    .replace(
      /\s*[(\[][^)\]]*(remaster|remix|live|bonus|deluxe|edit|version|mono|stereo|feat\.?|ft\.?|featuring)[^)\]]*[)\]]/gi,
      ''
    )
    .replace(/\s*-\s*(remastered.*|remix.*|live.*|bonus.*|mono|stereo)\s*$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First credited artist only — "A, B" / "A feat. B" breaks artist filters. */
export function primaryArtist(s) {
  if (!s) return '';
  return s
    .split(',')[0]
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .trim();
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

  const primary = primaryArtist(artist).toLowerCase();
  if (primary) {
    const byArtist = hits.filter((x) => {
      const name = (x.artistName || '').toLowerCase();
      return name.includes(primary) || primary.includes(name.split(',')[0].trim());
    });
    if (byArtist.length) hits = byArtist;
  }

  const want = cleanTrackTitle(track) || track;
  hits.sort((x, y) => titleScore(want, y.trackName) - titleScore(want, x.trackName));
  const best = hits[0];
  return titleScore(want, best.trackName) >= minScore ? best : null;
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
  const cleaned = cleanTrackTitle(track) || track;
  const primary = primaryArtist(artist);
  const ctx = { artist: primary || artist, track: cleaned };
  const variants = [...new Set([cleaned, track, normalizeTitle(track)].filter(Boolean))];

  for (const name of variants) {
    const params = new URLSearchParams({ track_name: name });
    if (primary) params.set('artist_name', primary);
    const list = await fetchSearch(params);
    const hit = pickBestMatch(list, ctx);
    if (hit) return toResult(hit);
  }

  const firstWord = cleaned.trim().split(/\s+/)[0];
  if (firstWord && primary && firstWord.length >= 3) {
    const params = new URLSearchParams({ track_name: firstWord, artist_name: primary });
    const list = await fetchSearch(params);
    const hit = pickBestMatch(list, ctx);
    if (hit) return toResult(hit);
  }

  return null;
}

export async function fetchFromLRCLIB({ artist, track, album, duration }) {
  const cleaned = cleanTrackTitle(track) || track;
  const primary = primaryArtist(artist);
  const params = new URLSearchParams({ track_name: cleaned });
  if (primary) params.set('artist_name', primary);
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
  return search({ artist: primary || artist, track: cleaned });
}
