import {
  fetchLyrics,
  TranscriptFailedError,
  transcriptSkipHint,
} from './providers/lyrics/index.js';
import { parseLyrics } from './providers/formats/index.js';
import { attachLineText } from './providers/formats/translation.js';
import { estimateTimeline } from './providers/formats/estimate.js';
import {
  cacheKey,
  getCachedTimeline,
  applyCachedTiming,
  putCachedTimeline,
} from './timeline-cache.js';
import { needsVocalAlign, isWordSyncFormat } from './align.js';
import { hydrateFromSidecar, saveToSidecar } from './sidecar.js';

/**
 * Orchestrates lyrics loading, timeline parsing, and active medium/clock.
 */
export class SongSession {
  constructor({ display, clocks, onMeta, onError, onStatus }) {
    this.display = display;
    this.clocks = clocks; // { media, demo, vinyl, streaming }
    this.onMeta = onMeta || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});

    this.timeline = null;
    this.meta = null;
    this.cacheKey = null;
    this.activeClock = null;
    this.medium = null;
    this.lyricsFile = null;
    this.lyricsFileAuto = false;
    this.audioFile = null;
    this.audioTags = null;
    // Bumped on every load/apply so in-flight fetches/alignments from a previous
    // song can detect they're stale and discard their results.
    this.loadGeneration = 0;
  }

  // `auto` marks a sidecar we paired by filename rather than one the user picked.
  // An auto-paired file is a guess, so it yields to richer catalog timing; an
  // explicit import stays authoritative. See fetchCatalogLyrics.
  setLyricsFile(file, { auto = false } = {}) {
    this.lyricsFile = file || null;
    this.lyricsFileAuto = !!file && auto;
  }

  setAudioFile(file, tags) {
    this.audioFile = file || null;
    this.audioTags = tags || null;
  }

  async load({
    artist,
    track,
    album,
    duration,
    id,
    spotifyId,
    quietMiss = false,
    // Spotify must exhaust catalogs only — AI runs separately via capture.
    // Local audio may opt into file transcription after catalogs miss.
    allowTranscript = true,
  }) {
    const gen = ++this.loadGeneration;
    this.onStatus('loading', `Searching for “${track}”…`);
    let result;
    const lyricsQuery = {
      artist,
      track,
      album,
      duration,
      lyricsFile: this.lyricsFile,
      lyricsFileAuto: this.lyricsFileAuto,
      // Never feed a leftover local file into a catalog-only (Spotify) load.
      audioFile: allowTranscript ? this.audioFile : undefined,
      onStatus: this.onStatus,
    };
    try {
      result = await fetchLyrics(lyricsQuery, { allowTranscript });
    } catch (err) {
      if (gen !== this.loadGeneration) return false;
      if (err instanceof TranscriptFailedError || err?.code === 'TRANSCRIPT_FAILED') {
        if (!quietMiss) {
          this.onError(
            `No catalog lyrics for “${track}”. Transcription failed: ${err.message}`
          );
        }
        return false;
      }
      this.onError('Couldn’t reach the lyrics service. Check your connection and try again.');
      return false;
    }

    if (gen !== this.loadGeneration) return false;

    if (!result) {
      if (!quietMiss) {
        const hint = transcriptSkipHint(lyricsQuery);
        this.onError(
          hint ||
            `No lyrics found for “${track}”. Try adding the artist, importing a lyrics file, or a different spelling.`
        );
      }
      return false;
    }

    // Pull any on-disk alignment into localStorage first, so `applyResult`'s
    // synchronous cache lookup can find it. Bounded by the fetch we just did —
    // this costs one file stat in the common (no sidecar) case.
    await this.hydrateAlignment({ artist, track, album, duration, id, spotifyId, meta: result.meta });
    if (gen !== this.loadGeneration) return false;

    return this.applyResult(result, { artist, track, album, duration, id, spotifyId, gen });
  }

  /**
   * Import a durable sidecar for this track before the cache is consulted.
   * Tries the key we're about to load under, and the key the resolved metadata
   * implies, since catalog metadata can differ from what the user typed.
   */
  async hydrateAlignment({ artist, track, album, duration, id, spotifyId, meta } = {}) {
    const keys = new Set(
      [
        cacheKey({ artist, track, album, duration, id, spotifyId }),
        cacheKey({
          artist: meta?.artistName || artist,
          track: meta?.trackName || track,
          duration: duration || meta?.duration,
          id: id || spotifyId || meta?.id,
          spotifyId,
        }),
      ].filter(Boolean)
    );
    if (!keys.size && !this.audioFile) return false;

    let imported = false;
    for (const key of keys.size ? keys : [null]) {
      const res = await hydrateFromSidecar({ key, audioFile: this.audioFile });
      if (res.imported) imported = true;
    }
    return imported;
  }

  /**
   * Install an already-fetched lyrics result (catalog or AI transcript).
   * Used by Spotify capture transcription after catalogs miss.
   */
  applyResult(result, { artist, track, album, duration, id, spotifyId, gen } = {}) {
    if (gen != null && gen !== this.loadGeneration) return false;
    // Fresh apply from outside load() (e.g. Spotify AI) still needs a generation
    // bump so older in-flight work can't overwrite this install.
    if (gen == null) gen = ++this.loadGeneration;
    if (!result) {
      this.onError(`No lyrics found for “${track || 'this track'}”.`);
      return false;
    }

    // Prefer a ready-made timeline (AI ASR with timestamps), then plain text with
    // estimated timing, then catalog LRC/yrc/richsync.
    let timeline;
    if (result.timeline?.lines?.length) {
      timeline = result.timeline;
    } else if (result.plain && result.synced === false) {
      timeline = estimateTimeline(result.plain, { duration: duration || result.meta?.duration });
    } else {
      const text = result.lrc || result.text;
      ({ timeline } = parseLyrics(text, result.format || 'lrc'));
      if (result.roman) attachLineText(timeline, result.roman, 'roman');
    }
    if (!timeline?.lines?.length) {
      this.onError('Found lyrics, but they had no timing data.');
      return false;
    }

    this.meta = {
      artist: result.meta?.artistName || artist,
      track: result.meta?.trackName || track,
      album: result.meta?.albumName || album,
      duration: duration || result.meta?.duration,
      source: result.source,
      format: result.format || (result.timeline ? 'asr' : result.plain ? 'plain' : 'lrc'),
      id: id || spotifyId || result.meta?.id || undefined,
      spotifyId: spotifyId || undefined,
    };
    this.cacheKey = cacheKey(this.meta);

    let fromCache = false;
    let provisionalCache = false;
    if (this.cacheKey && !isWordSyncFormat(this.meta.format)) {
      const cached = getCachedTimeline(this.cacheKey);
      // A stale entry (older aligner) is still far better than a syllable
      // guess: apply it provisionally so the song is instantly close, and let
      // the current aligner refine it in the background.
      if (cached?.timeline && applyCachedTiming(timeline, cached.timeline, {
        provisional: cached.stale,
      })) {
        fromCache = true;
        provisionalCache = !!cached.stale;
      }
    }

    this.timeline = timeline;
    const wordSync = isWordSyncFormat(this.meta.format) && timeline.wordSync !== false;
    this.display.setLyrics(timeline, {
      source: this.meta.source,
      format: this.meta.format,
      wordSync,
      aligned: !!timeline.aligned,
      // Cached word timing from an older aligner: real spans, being refreshed.
      // The badge must not call this "words estimated".
      provisional: !!timeline.provisional,
    });
    this.onMeta(this.meta);
    this.onStatus('', '');
    return {
      lines: timeline.lines.length,
      meta: this.meta,
      hasRoman: !!timeline.hasRoman,
      estimated: !!timeline.estimated,
      format: this.meta.format,
      wordSync,
      source: this.meta.source,
      aligned: !!timeline.aligned,
      fromCache,
      provisionalCache,
      rebound: !!timeline.rebound,
      cacheKey: this.cacheKey,
      needsAlign: needsVocalAlign(timeline, this.meta),
    };
  }

  /**
   * Persist the current timeline after forced alignment succeeds.
   * localStorage is written synchronously (the caller's return value); the
   * durable sidecar is written fire-and-forget, since losing it costs
   * durability on the next run, never correctness on this one.
   */
  saveAlignedCache() {
    if (!this.cacheKey || (!this.timeline?.aligned && !this.timeline?.humanEdited)) return false;
    const saved = putCachedTimeline(this.cacheKey, this.timeline, this.meta || {});
    if (saved) {
      saveToSidecar({ key: this.cacheKey, audioFile: this.audioFile }).catch(() => {});
    }
    return saved;
  }

  setClock(clock) {
    this.activeClock = clock;
    this.display.setClock(clock);
  }

  get clock() {
    return this.activeClock;
  }

  destroy() {
    if (this.medium?.stop) this.medium.stop();
    this.medium = null;
    this.timeline = null;
    this.meta = null;
    this.cacheKey = null;
  }
}
