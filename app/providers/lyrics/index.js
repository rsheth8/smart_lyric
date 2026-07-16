import { fetchFromLRCLIB } from './lrclib.js';
import { fetchFromLocal } from './local.js';
import { fetchFromNetease } from './netease.js';

/** @typedef {import('./types.js')} LyricsResult */

/**
 * Try lyrics providers in order: local file (if attached) → NetEase word-level
 * (karaoke "yrc") → LRCLIB line-level. Word-level is preferred because it lets
 * the display follow the actual vocal beat instead of an even per-word sweep.
 * @param {{ artist?: string, track: string, album?: string, duration?: number, lyricsFile?: File }} query
 * @param {{ sources?: string[] }} [opts]
 * @returns {Promise<LyricsResult|null>}
 */
export async function fetchLyrics(query, { sources = ['local', 'netease', 'lrclib'] } = {}) {
  for (const source of sources) {
    if (source === 'local' && query.lyricsFile) {
      const result = await fetchFromLocal(query.lyricsFile);
      if (result?.text) return result;
    }
    if (source === 'netease') {
      const result = await fetchFromNetease(query);
      if (result) return result;
    }
    if (source === 'lrclib') {
      const result = await fetchFromLRCLIB(query);
      if (result) return result;
    }
  }
  return null;
}

export { fetchFromLRCLIB, normalizeTitle, titleScore, pickBestMatch, search } from './lrclib.js';
export { fetchFromLocal, basenamesMatch } from './local.js';
