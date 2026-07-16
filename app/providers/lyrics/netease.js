// Word-level lyrics via NetEase (returns karaoke "yrc" when available).
//
// NetEase sends no CORS header, so the browser can't call it directly. We go
// through a same-origin proxy (/api/lyrics — served by the dev server locally
// and by a Vercel function in prod), or the Electron main process via the
// smartLyric bridge (file:// has no proxy). Both return { yrc, lrc, meta }.

async function fetchViaBridgeOrProxy(query) {
  if (typeof window !== 'undefined' && window.smartLyric?.wordLyrics) {
    return window.smartLyric.wordLyrics(query);
  }
  const params = new URLSearchParams();
  if (query.artist) params.set('artist', query.artist);
  if (query.track) params.set('track', query.track);
  const res = await fetch(`/api/lyrics?${params}`, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * @returns {Promise<{ text: string, format: 'yrc'|'lrc', meta: object, source: string }|null>}
 *   Prefers word-level `yrc`; only returns line-level `lrc` if that's all NetEase
 *   has (LRCLIB is generally a better line-level source, so we let the chain fall
 *   through to it instead of returning NetEase line-level here).
 */
export async function fetchFromNetease(query) {
  let data;
  try {
    data = await fetchViaBridgeOrProxy(query);
  } catch {
    return null;
  }
  if (!data) return null;

  if (data.yrc && data.yrc.trim()) {
    return { text: data.yrc, format: 'yrc', meta: data.meta || {}, source: 'netease' };
  }
  return null; // no word-level timing → let LRCLIB handle line-level
}
