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
  constructor({
    rate = 1,
    now = () => performance.now() / 1000,
    correctionWindow = 4,
    jumpThreshold = 1.5,
    rateAlpha = 0.35,
    minRate = 0.94,
    maxRate = 1.06,
  } = {}) {
    this.rate = rate;
    this._playing = false;
    this._anchorSong = 0; // song position at the anchor moment
    this._anchorWall = 0; // wall time at that moment
    this._targetRate = rate;
    this._nowFn = now;
    this._correctionWindow = correctionWindow;
    this._jumpThreshold = jumpThreshold;
    this._rateAlpha = rateAlpha;
    this._minRate = minRate;
    this._maxRate = maxRate;
    this._rateSamples = 0;
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
    if (dw <= 0.5) return;
    const estimate = (song2 - song1) / dw;
    if (!Number.isFinite(estimate) || estimate < 0.8 || estimate > 1.2) return;
    const clamped = Math.max(this._minRate, Math.min(this._maxRate, estimate));

    // First good pair locks immediately. Later pairs are smoothed so one bad
    // fingerprint timestamp cannot make the lyrics visibly speed up/slow down.
    if (this._rateSamples === 0) {
      this._targetRate = clamped;
    } else {
      const delta = Math.abs(clamped - this._targetRate);
      if (this._rateSamples >= 3 && delta > 0.035) return;
      this._targetRate = this._targetRate * (1 - this._rateAlpha) + clamped * this._rateAlpha;
    }
    this._rateSamples++;
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
    jumpThreshold = 1.5,
    ease = 0.2,
    deadband = 0.15,
  } = {}) {
    this._isPlayingFn = isPlaying;
    // When an SDK exposes an exact position (e.g. MusicKit's currentPlaybackTime),
    // pass it here to bypass the ease model — there's nothing noisy to smooth.
    this._getPosition = getPosition;
    this._nowFn = now;
    this.lead = lead;
    // A genuine seek/track jump moves by seconds; anything smaller is treated as
    // poll noise to smooth, not a discontinuity to snap to.
    this.jumpThreshold = jumpThreshold;
    this.ease = ease;
    // Corrections smaller than this are ignored entirely. Spotify's polled
    // `progress_ms` is coarse (updates ~1/s, trails real output by a device
    // buffer) and reaches us over variable network latency, so it wobbles by a
    // few hundred ms poll-to-poll. Since digital playback runs at exactly rate
    // 1.0, our free-running clock is already accurate between polls — chasing
    // that wobble is what made the highlight drift "randomly ahead/behind."
    this.deadband = deadband;
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

  // Noisy measurement from a follow-poll. Three bands, so the coarse ~1.5s poll
  // never shows up as a visible hitch:
  //   • within the deadband → hold (the free-running clock is already right);
  //   • up to the jump threshold → ease a fraction toward it (invisible drift-track);
  //   • beyond it → a real seek/track jump, snap straight to truth.
  // Callers should `set()` instead on discontinuities they initiate.
  observe(measuredSongTime) {
    // An exact SDK position needs no smoothing (and position() ignores the anchor).
    if (this._getPosition) return;
    if (!this.isPlaying()) {
      this.set(measuredSongTime);
      return;
    }
    const predicted = this.position();
    const error = measuredSongTime - predicted;
    const mag = Math.abs(error);
    if (mag > this.jumpThreshold) {
      this.set(measuredSongTime);
      return;
    }
    if (mag < this.deadband) return; // poll noise — don't inject it as wander
    this._anchorSong = predicted + error * this.ease;
    this._anchorWall = this._nowFn();
  }
}
