import { connectSpotify, disconnectSpotify, getStreamingClock, parseSpotifyHashToken } from '../streaming/spotify.js';
import { registerMedium } from './index.js';

export const spotifyMedium = {
  id: 'spotify',
  label: 'Spotify',
  canUse: () => !!(typeof window !== 'undefined' && window.__SL_CONFIG__?.spotifyClientId),
  _connected: false,

  async start({ session, onError, onStatus, onState, prepareSong, firstPollDelayMs }) {
    this._connected = await connectSpotify({
      onTrack: (meta) =>
        prepareSong({
          artist: meta.artist,
          track: meta.title,
          album: meta.album,
          duration: meta.duration,
        }),
      onError,
      onStatus,
      onState,
      firstPollDelayMs,
    });
    if (this._connected) {
      const clock = getStreamingClock();
      if (clock) session.setClock(clock);
    }
  },

  stop() {
    disconnectSpotify();
    this._connected = false;
  },

  isActive() {
    return this._connected;
  },
};

registerMedium(spotifyMedium);
export { parseSpotifyHashToken };
