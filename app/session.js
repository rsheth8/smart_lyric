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

const WORD_SYNC_FORMATS = new Set(['yrc', 'richsync', 'ass']);

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
    this.audioFile = null;
    this.audioTags = null;
  }

  setLyricsFile(file) {
    this.lyricsFile = file || null;
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
    this.onStatus('loading', `Searching for “${track}”…`);
    let result;
    const lyricsQuery = {
      artist,
      track,
      album,
      duration,
      lyricsFile: this.lyricsFile,
      // Never feed a leftover local file into a catalog-only (Spotify) load.
      audioFile: allowTranscript ? this.audioFile : undefined,
      onStatus: this.onStatus,
    };
    try {
      result = await fetchLyrics(lyricsQuery, { allowTranscript });
    } catch (err) {
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

    return this.applyResult(result, { artist, track, album, duration, id, spotifyId });
  }

  /**
   * Install an already-fetched lyrics result (catalog or AI transcript).
   * Used by Spotify capture transcription after catalogs miss.
   */
  applyResult(result, { artist, track, album, duration, id, spotifyId } = {}) {
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
    if (this.cacheKey && !WORD_SYNC_FORMATS.has(this.meta.format)) {
      const cached = getCachedTimeline(this.cacheKey);
      if (cached?.timeline && applyCachedTiming(timeline, cached.timeline)) {
        fromCache = true;
      }
    }

    this.timeline = timeline;
    const wordSync = WORD_SYNC_FORMATS.has(this.meta.format);
    this.display.setLyrics(timeline, {
      source: this.meta.source,
      format: this.meta.format,
      wordSync,
      aligned: !!timeline.aligned,
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
      cacheKey: this.cacheKey,
      needsAlign: !wordSync && !timeline.aligned,
    };
  }

  /** Persist the current timeline after forced alignment succeeds. */
  saveAlignedCache() {
    if (!this.cacheKey || !this.timeline?.aligned) return false;
    return putCachedTimeline(this.cacheKey, this.timeline, this.meta || {});
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
