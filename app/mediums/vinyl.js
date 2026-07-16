import { VinylDetector } from '../vinyl.js';
import { registerMedium } from './index.js';

export const vinylMedium = {
  id: 'vinyl',
  label: 'Listen to a record',
  canUse: () => !!(typeof window !== 'undefined' && window.bar4bar?.identify),
  _detector: null,
  _mic: null,

  async start({ session, vinylClock, mic, onState, onStatus, onResult, useAmbient, prepareSong }) {
    this._mic = mic;
    session.setClock(vinylClock);

    // ACRCloud (ambient/landmark) when configured — it recognizes music through a
    // room mic; AcoustID/Chromaprint only matches near-identical digital audio.
    const recognize = useAmbient
      ? (wav) => window.bar4bar.identifyAmbient(wav)
      : (wav) => window.bar4bar.identify(wav);

    this._detector = new VinylDetector({
      identify: async (wav) => {
        const r = await recognize(wav);
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
      onResult,
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
