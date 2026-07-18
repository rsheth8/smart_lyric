import { fetchFromLRCLIB, cleanTrackTitle, primaryArtist } from './lrclib.js';
import { fetchFromLocal } from './local.js';
import { fetchFromNetease } from './netease.js';
import { fetchFromMusixmatch } from './musixmatch.js';
import { fetchPlain } from './plain.js';
import { fetchTranscriptFromAudio, transcriptionAvailable } from './transcript.js';
import { preferResult } from './match.js';

/** @typedef {import('./types.js')} LyricsResult */

/** Error thrown when a catalog miss is followed by a failed AI transcription attempt. */
export class TranscriptFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptFailedError';
    this.code = 'TRANSCRIPT_FAILED';
  }
}

const CATALOG_SOURCES = ['local', 'netease', 'musixmatch', 'lrclib'];

/**
 * Exhaust every non-AI lyrics source. AI transcription must never run until this
 * returns null — synced catalogs, title-only retries, then plain text (LRCLIB /
 * lyrics.ovh / Genius), also with a title-only pass.
 *
 * @param {{ artist?: string, track: string, album?: string, duration?: number, lyricsFile?: File }} query
 * @param {{ sources?: string[], plain?: boolean }} [opts]
 * @returns {Promise<LyricsResult|null>}
 */
export async function fetchCatalogLyrics(
  query,
  { sources = CATALOG_SOURCES, plain = true } = {}
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
  let best = preferResult([yrc, musixmatch, neteaseLine, lrclib], query.duration);

  // Streaming metadata often credits a playback-singer the lyric catalogs don't
  // know (common for Bollywood/regional tracks). Title-only retries against the
  // synced providers rescue those before we give up on timed lyrics.
  if (!best && cleaned.artist) {
    const titleJobs = [];
    if (sources.includes('musixmatch')) {
      titleJobs.push(fetchFromMusixmatch({ ...cleaned, artist: undefined }));
    } else {
      titleJobs.push(Promise.resolve(null));
    }
    if (sources.includes('lrclib')) {
      titleJobs.push(fetchFromLRCLIB({ ...cleaned, artist: undefined }));
    } else {
      titleJobs.push(Promise.resolve(null));
    }
    const [mmOnly, lrOnly] = await Promise.all(titleJobs);
    best = preferResult([mmOnly, lrOnly], query.duration);
  }
  if (best) return best;

  // Nothing synced. Fall back to plain (untimed) text — the display estimates a
  // scroll from the duration. Off only when a caller explicitly opts out.
  if (plain) {
    const p = await fetchPlain(cleaned);
    if (p) return p;
    if (cleaned.artist) {
      const titleOnlyPlain = await fetchPlain({ ...cleaned, artist: undefined });
      if (titleOnlyPlain) return titleOnlyPlain;
    }
  }

  return null;
}

/**
 * Catalog lyrics first; AI transcription only if every catalog source missed
 * and the caller allowed it (local audio file path). Spotify AI uses a separate
 * capture path and must call fetchCatalogLyrics alone before transcribing.
 *
 * @param {{ artist?: string, track: string, album?: string, duration?: number, lyricsFile?: File, audioFile?: File }} query
 * @param {{ sources?: string[], plain?: boolean, allowTranscript?: boolean }} [opts]
 */
export async function fetchLyrics(
  query,
  {
    sources = [...CATALOG_SOURCES, 'transcript'],
    plain = true,
    allowTranscript = true,
  } = {}
) {
  const catalogSources = sources.filter((s) => s !== 'transcript');
  const catalog = await fetchCatalogLyrics(query, { sources: catalogSources, plain });
  if (catalog) return catalog;

  // Absolute last resort: only after every catalog/plain source returned nothing.
  if (allowTranscript && sources.includes('transcript') && query.audioFile) {
    const transcript = await fetchTranscriptFromAudio({
      ...query,
      track: cleanTrackTitle(query.track) || query.track,
      artist: primaryArtist(query.artist) || query.artist,
    });
    if (transcript?.plain || transcript?.timeline) return transcript;
    if (transcript?.error) throw new TranscriptFailedError(transcript.error);
  }
  return null;
}

/** Hint for the UI when catalogs miss and transcription never started. */
export function transcriptSkipHint(query = {}) {
  if (!transcriptionAvailable()) {
    return 'AI lyrics need the desktop app (npm start).';
  }
  if (!query.audioFile) {
    return 'No catalog lyrics. Choose Audio file and Load, or play on Spotify — Bar4Bar will listen and transcribe.';
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
