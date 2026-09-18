import { registerMedium } from './index.js';

export const musicVideoMedium = {
  id: 'musicVideo',
  label: 'Music video',
  canUse: () => true,
  start({ session, clock, videoEl }) {
    if (clock) session.setClock(clock);
    this._video = videoEl || null;
    this._clock = clock || null;
  },
  stop() {
    if (this._video && !this._video.paused) this._video.pause();
    this._video = null;
    this._clock = null;
  },
  play() {
    return this._video?.play();
  },
  pause() {
    this._video?.pause();
  },
  isPlaying() {
    return this._video ? !this._video.paused && !this._video.ended : false;
  },
};

registerMedium(musicVideoMedium);
