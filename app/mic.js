// Microphone capture for auto-detect. Keeps a rolling buffer of the last N
// seconds of audio and remembers when playback started (audio onset), so the
// detector can compute song position as `now - onsetAt`.
//
// Browser/Electron-renderer only (needs getUserMedia + Web Audio). The pure
// helpers it relies on (encodeWAV, rms) live in wav.js and are unit-tested.

import { encodeWAV, rms } from './wav.js';

export class Mic {
  constructor({ seconds = 12, sampleRate = 44100, onsetThreshold = 0.02 } = {}) {
    this.seconds = seconds;
    this.sampleRate = sampleRate;
    this.onsetThreshold = onsetThreshold;
    this.buffer = new Float32Array(seconds * sampleRate);
    this.writeIndex = 0;
    this.filled = false;
    this.onsetAt = null; // wall-clock (s) when audio first crossed the threshold
    this._ctx = null;
    this._node = null;
    this._stream = null;
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this._ctx = new AudioContext({ sampleRate: this.sampleRate });
    const source = this._ctx.createMediaStreamSource(this._stream);
    // ScriptProcessor is deprecated but universally available and fine here.
    this._node = this._ctx.createScriptProcessor(4096, 1, 1);
    this._node.onaudioprocess = (e) => this._onAudio(e.inputBuffer.getChannelData(0));
    source.connect(this._node);
    this._node.connect(this._ctx.destination);
  }

  _onAudio(input) {
    // Detect the moment the record starts (rising above the noise floor).
    if (this.onsetAt == null && rms(input) > this.onsetThreshold) {
      this.onsetAt = performance.now() / 1000;
    }
    // Append into the ring buffer.
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.writeIndex] = input[i];
      if (++this.writeIndex >= this.buffer.length) {
        this.writeIndex = 0;
        this.filled = true;
      }
    }
  }

  // Return the last N seconds as a WAV plus the onset time, or null if we haven't
  // heard the music start yet.
  async captureChunk() {
    if (this.onsetAt == null) return null;
    const ordered = this._orderedBuffer();
    return { wav: encodeWAV(ordered, this.sampleRate), onsetAt: this.onsetAt };
  }

  _orderedBuffer() {
    if (!this.filled) return this.buffer.slice(0, this.writeIndex);
    const out = new Float32Array(this.buffer.length);
    const tail = this.buffer.length - this.writeIndex;
    out.set(this.buffer.subarray(this.writeIndex), 0);
    out.set(this.buffer.subarray(0, this.writeIndex), tail);
    return out;
  }

  stop() {
    try {
      this._node && this._node.disconnect();
      this._stream && this._stream.getTracks().forEach((t) => t.stop());
      this._ctx && this._ctx.close();
    } catch {
      /* ignore */
    }
    this.onsetAt = null;
    this.filled = false;
    this.writeIndex = 0;
  }
}
