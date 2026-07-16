import { fetchFromLRCLIB, cleanTrackTitle, primaryArtist } from './lrclib.js';
import { fetchFromLocal } from './local.js';
import { fetchFromNetease } from './netease.js';

/** @typedef {import('./types.js')} LyricsResult */

/**
 * Try lyrics providers: local file (if attached) → NetEase word-level + LRCLIB
 * in parallel (prefer NetEase yrc when both succeed). Racing them means a slow
 * NetEase call no longer blocks LRCLIB for 8s+ while Spotify is already playing.
 * @param {{ artist?: string, track: string, album?: string, duration?: number, lyricsFile?: File }} query
 * @param {{ sources?: string[] }} [opts]
 * @returns {Promise<LyricsResult|null>}
 */
export async function fetchLyrics(query, { sources = ['local', 'netease', 'lrclib'] } = {}) {
  if (sources.includes('local') && query.lyricsFile) {
    const result = await fetchFromLocal(query.lyricsFile);
    if (result?.text) return result;
  }

  const cleaned = {
    ...query,
    track: cleanTrackTitle(query.track) || query.track,
    artist: primaryArtist(query.artist) || query.artist,
  };

  const jobs = [];
  if (sources.includes('netease')) jobs.push(fetchFromNetease(cleaned));
  if (sources.includes('lrclib')) jobs.push(fetchFromLRCLIB(cleaned));
  if (!jobs.length) return null;

  const results = await Promise.all(jobs);
  const netease = results.find((r) => r?.source === 'netease');
  if (netease) return netease;
  const lrclib = results.find((r) => r?.source === 'lrclib');
  if (lrclib) return lrclib;
  return null;
}

export {
  fetchFromLRCLIB,
  normalizeTitle,
  cleanTrackTitle,
  primaryArtist,
  titleScore,
  pickBestMatch,
  search,
} from './lrclib.js';
export { fetchFromLocal, basenamesMatch } from './local.js';
