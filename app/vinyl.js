// VinylDetector: turns a stream of microphone fingerprints into a locked, synced
// clock. It's the bridge between the Step 0 recognition idea and the display.
//
// Position/latency handling: identification takes several seconds, so we can't
// use "when the answer arrived" as the song position. Instead the mic reports
// `onsetAt` — the wall-clock moment the record started playing (first audio). The
// song position at any instant is therefore `now - onsetAt`, which stays correct
// no matter how long fingerprinting took. (Dropping the needle mid-record is the
// harder case; it needs fingerprint-offset alignment, a future enhancement.)
//
// All dependencies are injected, so the whole state machine is unit-testable with
// fakes — no mic, no network.

export class VinylDetector {
  constructor({
    identify, // (wavArrayBuffer) => Promise<{recordingId,title,artist,album,duration,score}|null>
    getChunk, // () => Promise<{ wav, onsetAt } | null>
    clock, // a PredictiveClock
    onSong, // async (meta) => void   — fetch lyrics/art, prep the display
    onState, // (state) => void
    now = () => performance.now() / 1000,
    intervalMs = 5000,
    missTolerance = 4, // consecutive misses before we consider the music stopped
    minScore = 0.5, // ignore low-confidence matches
  }) {
    this.identify = identify;
    this.getChunk = getChunk;
    this.clock = clock;
    this.onSong = onSong;
    this.onState = onState;
    this.now = now;
    this.intervalMs = intervalMs;
    this.missTolerance = missTolerance;
    this.minScore = minScore;

    this.state = 'idle'; // idle | listening | locked
    this.currentId = null;
    this.misses = 0;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._setState('listening');
    this._timer = setInterval(() => this.pollOnce(), this.intervalMs);
    this.pollOnce();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.currentId = null;
    this.misses = 0;
    this._setState('idle');
  }

  // One capture→identify→react cycle. Returns the result for testing/introspection.
  async pollOnce() {
    const chunk = await this.getChunk();
    if (!chunk || chunk.onsetAt == null) return null; // no audio detected yet

    let result = null;
    try {
      result = await this.identify(chunk.wav);
    } catch {
      result = null;
    }

    if (!result || (result.score != null && result.score < this.minScore)) {
      this._handleMiss();
      return null;
    }

    const position = Math.max(0, this.now() - chunk.onsetAt);

    if (result.recordingId !== this.currentId) {
      // A different song than we're currently following (or the first one).
      this.currentId = result.recordingId;
      this.misses = 0;
      await this.onSong(result);
      this.clock.observe(position); // starts the clock if it was stopped
      this._setState('locked');
    } else {
      // Same song — refine our position estimate and clear the miss counter.
      this.misses = 0;
      this.clock.observe(position);
    }
    return result;
  }

  _handleMiss() {
    if (this.state !== 'locked') return;
    if (++this.misses >= this.missTolerance) {
      // The music seems to have stopped or changed — release the lock.
      this.currentId = null;
      this.misses = 0;
      if (this.clock.pause) this.clock.pause();
      this._setState('listening');
    }
  }

  _setState(s) {
    if (s === this.state) return;
    this.state = s;
    if (this.onState) this.onState(s);
  }
}
