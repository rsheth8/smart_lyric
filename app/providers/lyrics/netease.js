import { parseYRC } from '../formats/yrc.js';

// Word-level lyrics via NetEase (returns karaoke "yrc" when available).
//
// NetEase sends no CORS header, so the browser can't call it directly. We go
// through a same-origin proxy (/api/lyrics — served by the dev server locally
// and by a Vercel function in prod), or the Electron main process via the
// bar4bar bridge (file:// has no proxy). Both return { yrc, lrc, meta }.

const BRIDGE_TIMEOUT_MS = 9000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('lyrics bridge timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fetchViaBridgeOrProxy(query) {
  if (typeof window !== 'undefined' && window.bar4bar?.wordLyrics) {
    return withTimeout(window.bar4bar.wordLyrics(query), BRIDGE_TIMEOUT_MS);
  }
  const params = new URLSearchParams();
  if (query.artist) params.set('artist', query.artist);
  if (query.track) params.set('track', query.track);
  if (query.duration) params.set('duration', String(query.duration));
  const res = await fetch(`/api/lyrics?${params}`, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * @returns {Promise<{ text: string, format: 'yrc'|'lrc', meta: object, source: string }|null>}
 *   Prefers word-level `yrc`; only returns when it actually parses to timed lines
 *   so we don't block LRCLIB with unusable NetEase payloads.
 */
export async function fetchFromNetease(query) {
  let data;
  try {
    data = await fetchViaBridgeOrProxy(query);
  } catch {
    return null;
  }
  if (!data) return null;

  // Romanized (Latin-letter) pronunciation overlay — the "sing-along" aid.
  const roman = (data.rlrc || '').trim() || null;
  if (data.yrc && data.yrc.trim()) {
    const { lines } = parseYRC(data.yrc);
    if (lines.length) {
      return { text: data.yrc, format: 'yrc', roman, meta: data.meta || {}, source: 'netease' };
    }
  }
  // No word-level timing. Normally we defer to LRCLIB for line-level lyrics — but
  // if NetEase carries a romanization, keep its line-level `lrc` so the
  // pronunciation overlay has aligned original text to sit under.
  if (roman && data.lrc && data.lrc.trim()) {
    return { lrc: data.lrc, format: 'lrc', roman, meta: data.meta || {}, source: 'netease' };
  }
  return null; // let LRCLIB handle line-level
}
