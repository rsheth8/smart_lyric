// VinylDetector: turns a stream of microphone fingerprints into a locked, synced
// clock. Uses fingerprint offset when available for mid-record needle drops.

export class VinylDetector {
  constructor({
    identify,
    getChunk,
    clock,
    onSong,
    onState,
    now = () => performance.now() / 1000,
    intervalMs = 5000,
    missTolerance = 4,
    minScore = 0.5,
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

    this.state = 'idle';
    this.currentId = null;
    this.misses = 0;
    this._timer = null;
    this._lastObs = null; // { song, wall } for calibrateRate
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
    this._lastObs = null;
    this._setState('idle');
  }

  _position(chunk, result) {
    if (result.offsetSec != null && Number.isFinite(result.offsetSec)) {
      return Math.max(0, result.offsetSec);
    }
    return Math.max(0, this.now() - chunk.onsetAt);
  }

  async pollOnce() {
    const chunk = await this.getChunk();
    if (!chunk || chunk.onsetAt == null) return null;

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

    const position = this._position(chunk, result);
    const wall = this.now();

    if (result.recordingId !== this.currentId) {
      this.currentId = result.recordingId;
      this.misses = 0;
      this._lastObs = { song: position, wall };
      await this.onSong(result);
      this.clock.observe(position);
      this._setState('locked');
    } else {
      this.misses = 0;
      if (this._lastObs && this.clock.calibrateRate) {
        this.clock.calibrateRate(this._lastObs.song, this._lastObs.wall, position, wall);
      }
      this._lastObs = { song: position, wall };
      this.clock.observe(position);
    }
    return result;
  }

  _handleMiss() {
    if (this.state !== 'locked') return;
    if (++this.misses >= this.missTolerance) {
      this.currentId = null;
      this.misses = 0;
      this._lastObs = null;
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
