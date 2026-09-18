import { fetchFromLRCLIB, cleanTrackTitle, primaryArtist } from './lrclib.js';
import { fetchFromLocal } from './local.js';
import { fetchFromNetease } from './netease.js';
import { fetchFromMusixmatch } from './musixmatch.js';
import { fetchPlain } from './plain.js';
import { fetchTranscriptFromAudio, transcriptionAvailable } from './transcript.js';
import { preferResult } from './match.js';
import { isWordSyncFormat } from '../../align.js';

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

/** A provider that throws (offline, rate-limited, 5xx) counts as "no result". */
const settle = (p) => (p ? Promise.resolve(p).catch(() => null) : Promise.resolve(null));

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
  // A lyrics file the user explicitly picked is authoritative — return it as-is.
  // An AUTO-PAIRED sidecar is only a filename guess, so it must not shadow a
  // catalog's word-level timing: a line-level .lrc sitting next to the audio used
  // to win outright, sending a rubato-heavy vocal (Adele, ballads) through the
  // aligner to have its word timing *invented* while real per-word timing (yrc /
  // richsync) existed. Such a sidecar is now held as a fallback and only yields
  // to genuinely richer timing below.
  let localFallback = null;
  if (sources.includes('local') && query.lyricsFile) {
    const result = await fetchFromLocal(query.lyricsFile);
    if (result?.text) {
      if (!query.lyricsFileAuto || isWordSyncFormat(result.format)) return result;
      localFallback = result;
    }
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

  // Staged settle: if a line-level hit arrives first, keep waiting briefly for
  // word-sync (yrc / richsync) so we don't paint syllable estimates that jump
  // when richer timing lands a second later. User preference: wait for quality.
  const WORD_SYNC_GRACE_MS = 2800;
  const state = { netease: undefined, musixmatch: undefined, lrclib: undefined };
  const pN = settle(jobs.netease).then((v) => {
    state.netease = v;
    return v;
  });
  const pM = settle(jobs.musixmatch).then((v) => {
    state.musixmatch = v;
    return v;
  });
  const pL = settle(jobs.lrclib).then((v) => {
    state.lrclib = v;
    return v;
  });
  const allDone = Promise.all([pN, pM, pL]);

  const preferFromState = () => {
    const netease = state.netease;
    const musixmatch = state.musixmatch === undefined ? null : state.musixmatch;
    const lrclib = state.lrclib === undefined ? null : state.lrclib;
    if (netease === undefined && state.musixmatch === undefined && state.lrclib === undefined) {
      return null;
    }
    const yrc = netease?.format === 'yrc' ? netease : null;
    const neteaseLine = netease && netease.format !== 'yrc' ? netease : null;
    const neteaseLineRoman = neteaseLine?.roman ? neteaseLine : null;
    const neteaseLineBare = neteaseLine && !neteaseLine.roman ? neteaseLine : null;
    // Still-in-flight providers contribute nothing yet (null), so a fast LRCLIB
    // hit doesn't get locked in while NetEase yrc is 1s away.
    return preferResult(
      [
        netease === undefined ? null : yrc,
        musixmatch,
        netease === undefined ? null : neteaseLineRoman,
        lrclib,
        netease === undefined ? null : neteaseLineBare,
      ],
      query.duration
    );
  };

  const started = Date.now();
  let best = null;
  while (Date.now() - started < WORD_SYNC_GRACE_MS) {
    best = preferFromState();
    if (best && isWordSyncFormat(best.format)) break;
    const pending =
      state.netease === undefined ||
      state.musixmatch === undefined ||
      state.lrclib === undefined;
    if (!pending) break;
    await Promise.race([allDone, new Promise((r) => setTimeout(r, 120))]);
  }
  await allDone;
  best = preferFromState();

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
    const [mmOnly, lrOnly] = await Promise.all(titleJobs.map(settle));
    best = preferResult([mmOnly, lrOnly], query.duration);
  }
  // The auto-paired sidecar yields ONLY to word-level timing (the thing it can't
  // provide). Anything else — a line-level catalog hit, a network failure, being
  // offline — and the local file still wins, so this can never regress a match.
  if (localFallback) return best && isWordSyncFormat(best.format) ? best : localFallback;
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
