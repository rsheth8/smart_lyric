import { VinylDetector } from '../vinyl.js';
import { registerMedium } from './index.js';

export const vinylMedium = {
  id: 'vinyl',
  label: 'Listen to a record',
  canUse: () => !!(typeof window !== 'undefined' && window.smartLyric?.identify),
  _detector: null,
  _mic: null,

  async start({ session, vinylClock, mic, onState, onStatus, prepareSong }) {
    this._mic = mic;
    session.setClock(vinylClock);

    this._detector = new VinylDetector({
      identify: async (wav) => {
        const r = await window.smartLyric.identify(wav);
        if (r?.error) {
          onStatus('error', `Fingerprint error: ${r.error}`);
          return null;
        }
        return r;
      },
      getChunk: () => mic.captureChunk(),
      clock: vinylClock,
      onSong: (meta) =>
        prepareSong({
          artist: meta.artist,
          track: meta.title,
          album: meta.album,
          duration: meta.duration,
        }),
      onState,
    });
    this._detector.start();
  },

  stop() {
    this._detector?.stop();
    this._mic?.stop();
    this._detector = null;
    this._mic = null;
  },

  get state() {
    return this._detector?.state || 'idle';
  },
};

registerMedium(vinylMedium);
