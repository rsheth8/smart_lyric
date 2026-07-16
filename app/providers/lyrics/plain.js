// Plain (untimed) lyrics fallback — used only when no synced source has the song.
// The display renders these with estimated timing (even scroll) or a plain reading
// mode. Order: LRCLIB plain (already CORS-friendly) → lyrics.ovh (CORS *) → Genius
// (server-side only: needs a token + page scrape). First hit wins.

import { fetchPlainFromLRCLIB, cleanTrackTitle, primaryArtist } from './lrclib.js';

const OVH_TIMEOUT_MS = 9000;

/** lyrics.ovh: free plain-text API, sends `access-control-allow-origin: *`. */
export async function fetchPlainFromLyricsOvh({ artist, track }) {
  const a = primaryArtist(artist);
  const t = cleanTrackTitle(track) || track;
  if (!a || !t) return null; // ovh needs both artist and title
  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`,
      { signal: AbortSignal.timeout(OVH_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const plain = (data?.lyrics || '').trim();
    if (!plain) return null;
    return { plain, synced: false, meta: { trackName: t, artistName: a }, source: 'lyrics.ovh' };
  } catch {
    return null;
  }
}

/** Genius via same-origin proxy / Electron bridge (token + scrape live server-side). */
export async function fetchPlainFromGenius(query) {
  try {
    let data;
    if (typeof window !== 'undefined' && window.bar4bar?.geniusLyrics) {
      data = await window.bar4bar.geniusLyrics(query);
    } else if (typeof fetch === 'function') {
      const params = new URLSearchParams();
      if (query.artist) params.set('artist', query.artist);
      if (query.track) params.set('track', query.track);
      const res = await fetch(`/api/genius?${params}`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return null;
      data = await res.json();
    }
    const plain = (data?.plain || '').trim();
    if (!plain) return null;
    return { plain, synced: false, meta: data.meta || {}, source: 'genius' };
  } catch {
    return null;
  }
}

const PLAIN_PROVIDERS = {
  'lrclib-plain': fetchPlainFromLRCLIB,
  'lyrics.ovh': fetchPlainFromLyricsOvh,
  genius: fetchPlainFromGenius,
};

/**
 * Try plain-lyrics providers in order; return the first non-empty result.
 * @returns {Promise<{ plain: string, synced: false, meta: object, source: string }|null>}
 */
export async function fetchPlain(query, order = ['lrclib-plain', 'lyrics.ovh', 'genius']) {
  for (const name of order) {
    const fn = PLAIN_PROVIDERS[name];
    if (!fn) continue;
    const result = await fn(query);
    if (result?.plain) return result;
  }
  return null;
}
