import { fetchLyrics } from './providers/lyrics/index.js';
import { parseLyrics } from './providers/formats/index.js';

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

    const text = result.lrc || result.text;
    const { timeline } = parseLyrics(text, result.format || 'lrc');
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
    };
    this.display.setLyrics(timeline);
    this.onMeta(this.meta);
    this.onStatus('', '');
    return { lines: timeline.lines.length, meta: this.meta };
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
