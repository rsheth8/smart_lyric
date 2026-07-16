import { registerMedium } from './index.js';
import { connectAppleMusic, disconnectAppleMusic, getStreamingClock } from '../streaming/appleMusic.js';

export const appleMusicMedium = {
  id: 'appleMusic',
  label: 'Apple Music',
  canUse: () => !!(typeof window !== 'undefined' && window.__SL_CONFIG__?.appleMusicDeveloperToken),
  _connected: false,

  async start({ session, onError, onStatus, prepareSong }) {
    this._connected = await connectAppleMusic({
      onTrack: (meta) =>
        prepareSong({
          artist: meta.artist,
          track: meta.title,
          album: meta.album,
          duration: meta.duration,
        }),
      onError,
      onStatus,
    });
    if (this._connected) {
      const clock = getStreamingClock();
      if (clock) session.setClock(clock);
    }
    return this._connected;
  },

  stop() {
    disconnectAppleMusic();
    this._connected = false;
  },

  isActive() {
    return this._connected;
  },
};

registerMedium(appleMusicMedium);
