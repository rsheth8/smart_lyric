// Fetch time-synced lyrics from LRCLIB (https://lrclib.net) — free, no API key,
// CORS-friendly. Returns { lrc, meta } on success, or null when nothing matched.
// Network/timeout failures THROW, so callers can tell "no match" from "offline".

const BASE = 'https://lrclib.net/api';
const TIMEOUT_MS = 10000;

// No custom headers: they'd trigger a CORS preflight that LRCLIB may reject
// (and Electron's renderer enforces this strictly). A plain GET is a "simple"
// cross-origin request — no preflight, more reliable.
const timedFetch = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

// Exact-ish match first (duration greatly improves accuracy), then fuzzy search.
export async function getSynced({ artist, track, album, duration }) {
  const params = new URLSearchParams({ track_name: track });
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  if (duration) params.set('duration', String(Math.round(duration)));

  // A failed exact match must not kill the search fallback, so swallow errors
  // here; if search also fails with a network error it throws (→ "offline").
  try {
    const res = await timedFetch(`${BASE}/get?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics) return { lrc: data.syncedLyrics, meta: data };
    }
  } catch {
    /* fall through to search */
  }
  return search({ artist, track });
}

export async function search({ artist, track }) {
  const params = new URLSearchParams({ track_name: track });
  if (artist) params.set('artist_name', artist);

  const res = await timedFetch(`${BASE}/search?${params}`);
  if (!res.ok) return null;
  const list = await res.json();
  const hit = list.find((x) => x.syncedLyrics);
  return hit ? { lrc: hit.syncedLyrics, meta: hit } : null;
}
