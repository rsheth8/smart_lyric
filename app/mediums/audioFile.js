import { registerMedium } from './index.js';

export const audioFileMedium = {
  id: 'audioFile',
  label: 'Audio file',
  canUse: () => true,
  start({ session, audioEl, mediaClock }) {
    session.setClock(mediaClock);
    this._audio = audioEl;
  },
  stop() {
    if (this._audio && !this._audio.paused) this._audio.pause();
  },
  play() {
    return this._audio?.play();
  },
  pause() {
    this._audio?.pause();
  },
  isPlaying() {
    return this._audio ? !this._audio.paused && !this._audio.ended : false;
  },
};

registerMedium(audioFileMedium);
