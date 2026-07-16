import { fetchLyrics } from './providers/lyrics/index.js';
import { parseLyrics } from './providers/formats/index.js';
import { attachLineText } from './providers/formats/translation.js';
import { estimateTimeline } from './providers/formats/estimate.js';

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

  async load({ artist, track, album, duration }) {
    this.onStatus('loading', `Searching for “${track}”…`);
    let result;
    try {
      result = await fetchLyrics({
        artist,
        track,
        album,
        duration,
        lyricsFile: this.lyricsFile,
      });
    } catch {
      this.onError('Couldn’t reach the lyrics service. Check your connection and try again.');
      return false;
    }

    if (!result) {
      this.onError(`No synced lyrics found for “${track}”. Try adding the artist, importing a file, or a different spelling.`);
      return false;
    }

    // Untimed plain lyrics → estimate a scroll from the song duration.
    let timeline;
    if (result.plain && result.synced === false) {
      timeline = estimateTimeline(result.plain, { duration: duration || result.meta?.duration });
    } else {
      const text = result.lrc || result.text;
      ({ timeline } = parseLyrics(text, result.format || 'lrc'));
      // Romanized pronunciation overlay (NetEase). English meaning is translated
      // lazily on demand (see app.js), not here, to avoid a per-song network hit.
      if (result.roman) attachLineText(timeline, result.roman, 'roman');
    }
    if (!timeline.lines.length) {
      this.onError('Found lyrics, but they had no timing data.');
      return false;
    }

    this.timeline = timeline;
    this.meta = {
      artist: result.meta?.artistName || artist,
      track: result.meta?.trackName || track,
      album: result.meta?.albumName || album,
      source: result.source,
      format: result.format || (result.plain ? 'plain' : 'lrc'),
    };
    const wordSync = ['yrc', 'richsync', 'ass'].includes(this.meta.format);
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
    };
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
  }
}
