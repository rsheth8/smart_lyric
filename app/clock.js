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
  constructor({ rate = 1, now = () => performance.now() / 1000, correctionWindow = 4, jumpThreshold = 1.5 } = {}) {
    this.rate = rate;
    this._playing = false;
    this._anchorSong = 0; // song position at the anchor moment
    this._anchorWall = 0; // wall time at that moment
    this._targetRate = rate;
    this._nowFn = now;
    this._correctionWindow = correctionWindow;
    this._jumpThreshold = jumpThreshold;
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

  // Resume from the frozen position (used when the record starts playing again
  // after a silence pause, before the next fingerprint poll re-anchors us).
  resume() {
    if (this._playing) return;
    this._anchorWall = this._wall();
    this._playing = true;
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
  observe(measuredSongTime, { jumpThreshold, correctionWindow } = {}) {
    const jump = jumpThreshold ?? this._jumpThreshold;
    const window = correctionWindow ?? this._correctionWindow;
    if (!this._playing) {
      this.start(measuredSongTime);
      return;
    }
    const predicted = this.now();
    const error = measuredSongTime - predicted; // +ve: we're behind the music

    if (error > jump) {
      // Behind the music — snap forward to truth.
      this._anchorSong = measuredSongTime;
      this._anchorWall = this._wall();
      this._targetRate = this.rate;
      return;
    }
    if (error < -jump * 3) {
      // Way ahead — likely a seek or track jump; snap backward.
      this._anchorSong = measuredSongTime;
      this._anchorWall = this._wall();
      this._targetRate = this.rate;
      return;
    }

    // Small/moderate error (including slightly ahead) — ease the rate, never jump
    // backward. Jumping back makes lyrics look like they're rewinding on vinyl.
    this._anchorSong = predicted;
    this._anchorWall = this._wall();
    this._targetRate = this.rate + error / window;
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

// Streaming follow-mode clock (Spotify / Apple Music).
//
// Unlike vinyl, digital playback runs at exactly rate 1.0 — it never drifts, so
// the only error is a fixed offset: the polled `progress_ms` is coarse (~1s) and
// trails the device's real audio output by a device-dependent buffer. If we
// hard-snapped to every poll the highlight would jitter up to twice a second.
// Instead we keep a free-running local timeline and *ease* toward each poll
// measurement, snapping only on real discontinuities (track change, seek, big
// gap). `lead` compensates for the device output buffer; the display's manual
// sync dial stacks on top of it.
export class StreamingClock {
  constructor({
    isPlaying,
    getPosition = null,
    now = () => performance.now() / 1000,
    lead = 0,
    jumpThreshold = 0.75,
    ease = 0.25,
  } = {}) {
    this._isPlayingFn = isPlaying;
    // When an SDK exposes an exact position (e.g. MusicKit's currentPlaybackTime),
    // pass it here to bypass the ease model — there's nothing noisy to smooth.
    this._getPosition = getPosition;
    this._nowFn = now;
    this.lead = lead;
    this.jumpThreshold = jumpThreshold;
    this.ease = ease;
    this._anchorSong = 0;
    this._anchorWall = now();
  }

  // Un-compensated song position (what a poll measures), for UI/state readouts.
  position() {
    if (this._getPosition) return this._getPosition();
    if (!this.isPlaying()) return this._anchorSong;
    return this._anchorSong + (this._nowFn() - this._anchorWall);
  }

  now() {
    return this.position() + this.lead;
  }

  isPlaying() {
    return this._isPlayingFn?.() ?? false;
  }

  // Authoritative reset — we started/seeked/paused playback ourselves, so this
  // position is exact. Re-anchor with no easing.
  set(songTime) {
    this._anchorSong = songTime;
    this._anchorWall = this._nowFn();
  }

  // Noisy measurement from a follow-poll. Ease toward it so steady-state
  // corrections are invisible; snap when it's too far off to hide (seek / new
  // track / long stall). Callers should `set()` instead on known discontinuities.
  observe(measuredSongTime) {
    if (!this.isPlaying()) {
      this.set(measuredSongTime);
      return;
    }
    const predicted = this.position();
    const error = measuredSongTime - predicted;
    if (Math.abs(error) > this.jumpThreshold) {
      this.set(measuredSongTime);
      return;
    }
    this._anchorSong = predicted + error * this.ease;
    this._anchorWall = this._nowFn();
  }
}
