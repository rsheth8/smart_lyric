// The SyncClock is the heart of the "perfectly synced, no delays" promise.
//
// The display never reads audio directly — it just asks a clock "what second of
// the song are we on?" every frame. Swapping how that answer is produced is what
// lets the same display follow either app-controlled playback OR external vinyl.
//
// Two implementations share one interface:  now(): number  ·  isPlaying(): boolean
//
//   MediaClock       — bound to an <audio> element. Sync is exact because we own
//                      playback. Used in Milestone 1.
//   PredictiveClock  — free-running local timeline that we periodically nudge with
//                      real position measurements (from mic fingerprinting). It
//                      predicts smoothly between measurements so highlighting never
//                      stutters, and eases toward each correction instead of jumping.
//                      This is the vinyl / auto-detect engine (Milestone 3).

export class MediaClock {
  constructor(mediaEl) {
    this.el = mediaEl;
  }
  now() {
    return this.el.currentTime;
  }
  isPlaying() {
    return !this.el.paused && !this.el.ended;
  }
}

export class PredictiveClock {
  // rate = song-seconds per wall-second. Vinyl rarely runs at exactly 1.0.
  // `now` is the wall-clock source in seconds; injectable so tests can control time.
  constructor({ rate = 1, now = () => performance.now() / 1000 } = {}) {
    this.rate = rate;
    this._playing = false;
    this._anchorSong = 0; // song position at the anchor moment
    this._anchorWall = 0; // wall time at that moment
    this._targetRate = rate;
    this._nowFn = now;
  }

  _wall() {
    return this._nowFn();
  }

  start(songTime = 0) {
    this._anchorSong = songTime;
    this._anchorWall = this._wall();
    this._playing = true;
  }

  pause() {
    if (!this._playing) return;
    this._anchorSong = this.now();
    this._anchorWall = this._wall();
    this._playing = false;
  }

  isPlaying() {
    return this._playing;
  }

  now() {
    if (!this._playing) return this._anchorSong;
    // Ease actual rate toward target rate so corrections are gradual.
    this.rate += (this._targetRate - this.rate) * 0.05;
    return this._anchorSong + (this._wall() - this._anchorWall) * this.rate;
  }

  // Feed a fresh, authoritative measurement of where the song actually is
  // (e.g. from a fingerprint match). `smoothing` sets how gently we converge:
  // small error → nudge the rate; large error (needle lifted / new track) → jump.
  observe(measuredSongTime, { jumpThreshold = 1.5 } = {}) {
    if (!this._playing) {
      this.start(measuredSongTime);
      return;
    }
    const predicted = this.now();
    const error = measuredSongTime - predicted; // +ve: we're behind the music

    if (Math.abs(error) > jumpThreshold) {
      // Too far off to hide — snap to truth.
      this._anchorSong = measuredSongTime;
      this._anchorWall = this._wall();
      this._targetRate = this.rate;
      return;
    }

    // Re-anchor at the current instant and bias the rate to close the gap over
    // the next correction window, so the drift is corrected invisibly.
    this._anchorSong = predicted;
    this._anchorWall = this._wall();
    const correctionWindow = 4; // seconds to absorb the error
    this._targetRate = this.rate + error / correctionWindow;
  }

  // Estimate playback rate from two measurements (vinyl speed calibration).
  calibrateRate(song1, wall1, song2, wall2) {
    const dw = wall2 - wall1;
    if (dw > 0.5) this._targetRate = (song2 - song1) / dw;
  }
}

// Position pushed in externally (OBS overlay / projector mirror).
export class PassiveClock {
  constructor() {
    this._position = 0;
    this._playing = false;
  }
  push(position, playing) {
    this._position = position;
    this._playing = !!playing;
  }
  now() {
    return this._position;
  }
  isPlaying() {
    return this._playing;
  }
}

// Wraps a streaming SDK position getter (Spotify / Apple Music).
export class StreamingClock {
  constructor({ getPosition, isPlaying }) {
    this._getPosition = getPosition;
    this._isPlaying = isPlaying;
  }
  now() {
    return this._getPosition?.() ?? 0;
  }
  isPlaying() {
    return this._isPlaying?.() ?? false;
  }
}
