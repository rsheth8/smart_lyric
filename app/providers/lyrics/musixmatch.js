// Musixmatch richsync (word-level) provider. apic-desktop sends no CORS header
// and the flow needs a secret-ish token, so this runs server-side: same-origin
// /api/richsync proxy (dev server / Vercel) or the Electron bridge. Best coverage
// is Western pop; soft-fails to null so the chain falls through.

import { parseRichsync } from '../formats/richsync.js';

const TIMEOUT_MS = 12000;

async function fetchViaBridgeOrProxy(query) {
  if (typeof window !== 'undefined' && window.bar4bar?.richsync) {
    return window.bar4bar.richsync(query);
  }
  const params = new URLSearchParams();
  if (query.artist) params.set('artist', query.artist);
  if (query.track) params.set('track', query.track);
  const res = await fetch(`/api/richsync?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * @returns {Promise<{ text: string, format: 'richsync', meta: object, source: string }|null>}
 *   Only returns when the richsync actually parses to timed lines.
 */
export async function fetchFromMusixmatch(query) {
  let data;
  try {
    data = await fetchViaBridgeOrProxy(query);
  } catch {
    return null;
  }
  if (!data?.richsync) return null;
  const { lines } = parseRichsync(data.richsync);
  if (!lines.length) return null;
  return { text: data.richsync, format: 'richsync', meta: data.meta || {}, source: 'musixmatch' };
}
