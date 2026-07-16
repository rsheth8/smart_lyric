import { fetchFromLRCLIB, cleanTrackTitle, primaryArtist } from './lrclib.js';
import { fetchFromLocal } from './local.js';
import { fetchFromNetease } from './netease.js';
import { fetchFromMusixmatch } from './musixmatch.js';
import { fetchPlain } from './plain.js';
import { preferResult } from './match.js';

/** @typedef {import('./types.js')} LyricsResult */

/**
 * Try lyrics providers: local file (if attached) → NetEase word-level, Musixmatch
 * richsync (word-level), and LRCLIB (line-level) in parallel. Word-by-word timing
 * "moves with the singer," so it wins: NetEase `yrc` first (it also carries a
 * romanization overlay), then Musixmatch `richsync` (the broadest word-level
 * catalog — Punjabi/Bollywood/Western), then line-level (NetEase+roman → LRCLIB).
 * Racing them means a slow provider never blocks a fast one while playback runs.
 * @param {{ artist?: string, track: string, album?: string, duration?: number, lyricsFile?: File }} query
 * @param {{ sources?: string[] }} [opts]
 * @returns {Promise<LyricsResult|null>}
 */
export async function fetchLyrics(
  query,
  { sources = ['local', 'netease', 'musixmatch', 'lrclib'], plain = true } = {}
) {
  if (sources.includes('local') && query.lyricsFile) {
    const result = await fetchFromLocal(query.lyricsFile);
    if (result?.text) return result;
  }

  const cleaned = {
    ...query,
    track: cleanTrackTitle(query.track) || query.track,
    artist: primaryArtist(query.artist) || query.artist,
  };

  const jobs = { netease: null, musixmatch: null, lrclib: null };
  if (sources.includes('netease')) jobs.netease = fetchFromNetease(cleaned);
  if (sources.includes('musixmatch')) jobs.musixmatch = fetchFromMusixmatch(cleaned);
  if (sources.includes('lrclib')) jobs.lrclib = fetchFromLRCLIB(cleaned);

  const [netease, musixmatch, lrclib] = await Promise.all([
    jobs.netease,
    jobs.musixmatch,
    jobs.lrclib,
  ]);

  // Preference order = richest timing first (word-level visibly tracks the
  // singer's phrasing): NetEase yrc → Musixmatch richsync → NetEase line+roman →
  // LRCLIB line. But "prefer word-level" must not hand back the *wrong take*: a
  // provider can return a same-titled cover / live / remix whose length is way
  // off. `preferResult` keeps this order yet skips any candidate whose duration
  // grossly mismatches the target, so a bad word-level hit yields to a correct
  // line-level one. With no target duration, order is preserved (old behavior).
  const yrc = netease?.format === 'yrc' ? netease : null;
  const neteaseLine = netease && netease.format !== 'yrc' ? netease : null;
  const best = preferResult([yrc, musixmatch, neteaseLine, lrclib], query.duration);
  if (best) return best;

  // Nothing synced. Fall back to plain (untimed) text — the display estimates a
  // scroll from the duration. Off only when a caller explicitly opts out.
  if (plain) {
    const p = await fetchPlain(cleaned);
    if (p) return p;
  }
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
