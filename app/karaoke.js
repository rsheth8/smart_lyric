// The karaoke audio chain: the singer's voice out of the speakers, the record's
// voice out of the way, and the whole track moved into their key.
//
//   <audio> ─┬─ mix ─────────────────────────┐
//            ├─ (L − R) ── side ─────────────┤
//            ├─ lowpass  ── bass ────────────┼→ [key shift] → out → speakers
//            ├─ highpass ── air ─────────────┘        │
//            └─ trackAnalyser (pre-reduction: the melody we score against)
//
//   mic ─┬─ analyser (always on — scoring works with the monitor muted)
//        └─ monitor ─┬─ dry ──────┐
//                    └─ reverb ───┴→ out → speakers
//
// Vocal reduction is the old stereo trick: a lead vocal is mixed dead centre, so
// L − R deletes it. It also deletes the bass and anything else centred, which is
// why the low and high bands are folded back in at unity — the classic karaoke
// filter. It cannot work on a mono track (L − R is silence there), and it can't
// touch Spotify or a record, because that audio never passes through us.
//
// Everything below the class is pure, so the gain law, the key maths and the
// feedback policy unit-test without Web Audio.

import { createShifter, bestOffset, solaFrame, compact, shiftInto, SEQUENCE } from './pitch-shift.js';

/** Below this the centre-cancelled signal is gone: the track is mono. */
export const MONO_RATIO = 0.05;
/** Keep everything under this from the original mix — cancelling kills the bass. */
export const BASS_HZ = 200;
/** …and everything over this, so cymbals and air survive. */
export const AIR_HZ = 9000;
export const KEY_MIN = -6;
export const KEY_MAX = 6;
/** Sustained monitor level above this is a howl starting, not a singer. */
export const FEEDBACK_LEVEL = 0.55;
/** How long it has to sustain before we pull the monitor down. */
export const FEEDBACK_HOLD_MS = 900;
export const REVERB_SECONDS = 1.8;

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Read a stored 0–100 preference. Guards the one that bit: a missing key comes
 * back as null, and Number(null) is 0 — so a naive read silently pins every
 * slider to zero instead of falling back to its default.
 */
export function readPercent(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

export function clampKey(semitones) {
  const n = Math.round(Number(semitones) || 0);
  return Math.max(KEY_MIN, Math.min(KEY_MAX, n));
}

export function semitoneRatio(semitones) {
  return 2 ** (clampKey(semitones) / 12);
}

/** "+2" / "−3" / "Original" for the key readout. */
export function keyLabel(semitones) {
  const n = clampKey(semitones);
  if (n === 0) return 'Original';
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}

/**
 * Gains for the four paths at a given vocal level (1 = untouched, 0 = gone).
 * The low and high bands sum to unity at every setting — mix carries `level` of
 * them and the band path carries the rest — so only the middle crossfades.
 */
export function vocalGains(level) {
  const mix = clamp01(level);
  const cancel = 1 - mix;
  return { mix, side: cancel, bass: cancel, air: cancel };
}

/** Exponential tail for the reverb impulse. */
export function decayEnvelope(i, n, decay = 2.4) {
  if (n <= 0) return 0;
  return (1 - i / n) ** decay;
}

/**
 * Is the centre-cancelled bus silent while the mix is loud? Then L === R and
 * there is no vocal to pull out of this track.
 */
export function looksMono(mixLevel, sideLevel, ratio = MONO_RATIO) {
  if (!(mixLevel > 0.01)) return false; // too quiet to tell
  return sideLevel < mixLevel * ratio;
}

/**
 * Howl guard. Monitoring a mic through the same speakers it can hear is a
 * feedback loop; this notices the runaway before it deafens anyone.
 * Pure — `now` is passed in — so the policy is testable.
 */
export class FeedbackGuard {
  constructor({ level = FEEDBACK_LEVEL, holdMs = FEEDBACK_HOLD_MS } = {}) {
    this.level = level;
    this.holdMs = holdMs;
    this.since = null;
  }

  reset() {
    this.since = null;
  }

  /** True the moment a sustained howl is confirmed. */
  update(micLevel, now) {
    if (micLevel < this.level) {
      this.since = null;
      return false;
    }
    // null, not 0, so a timestamp of 0 still arms the timer.
    if (this.since == null) {
      this.since = now;
      return false;
    }
    if (now - this.since >= this.holdMs) {
      this.since = null;
      return true;
    }
    return false;
  }
}

// The AudioWorklet has no import graph, so the shifter goes in as source text.
// These functions are written self-contained in pitch-shift.js for exactly this.
// Exported so a test can actually run the round-trip: stringify → evaluate →
// shift a tone. A stray closure reference in pitch-shift.js would only ever
// show up as silence on a real machine otherwise.
export function workletSource() {
  const body = [createShifter, bestOffset, solaFrame, compact, shiftInto]
    .map((fn) => fn.toString())
    .join('\n\n');
  return `${body}

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.states = [];
  }
  process(inputs, outputs, params) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const ratio = params.ratio[0];
    for (let ch = 0; ch < output.length; ch++) {
      if (!this.states[ch]) this.states[ch] = createShifter({});
      shiftInto(this.states[ch], input[ch] || null, output[ch], ratio);
    }
    return true;
  }
}
registerProcessor('pitch-shift', PitchShiftProcessor);
`;
}

const FFT = 2048;

export class KaraokeAudio {
  /**
   * @param {object} o
   * @param {HTMLMediaElement} o.audioEl the element karaoke controls act on
   * @param {(msg: string) => void} [o.onNotice] user-facing warnings
   */
  constructor({ audioEl, onNotice = () => {} } = {}) {
    this.audioEl = audioEl;
    this.onNotice = onNotice;
    this.ctx = null;
    this.vocalLevel = 1;
    this.key = 0;
    this.monitoring = false;
    this.micLevel = 0.7;
    this.reverb = 0.25;
    this.guard = new FeedbackGuard();
    this._micStream = null;
    this._warnedMono = false;
    this._buf = new Float32Array(FFT);
    this._trackBuf = new Float32Array(FFT);
  }

  /** True once anything has actually routed the element through Web Audio. */
  get engaged() {
    return !!this.ctx;
  }

  get latencySec() {
    return this.key === 0 || !this.ctx ? 0 : SEQUENCE / this.ctx.sampleRate;
  }

  /**
   * Build the graph. Deferred until a karaoke control is actually used, because
   * createMediaElementSource is one-way — once the element is in the graph it
   * plays through the graph forever.
   */
  async ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not available in this browser');
    const ctx = new Ctx();
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.connect(ctx.destination);

    if (this.audioEl) {
      this.source = ctx.createMediaElementSource(this.audioEl);

      this.mixGain = ctx.createGain();
      this.sideGain = ctx.createGain();
      this.bassGain = ctx.createGain();
      this.airGain = ctx.createGain();

      const splitter = ctx.createChannelSplitter(2);
      const left = ctx.createGain();
      const right = ctx.createGain();
      left.gain.value = 1;
      right.gain.value = -1; // L − R: whatever sits dead centre cancels itself
      this.source.connect(splitter);
      splitter.connect(left, 0);
      splitter.connect(right, 1);
      const side = ctx.createGain();
      left.connect(side);
      right.connect(side);
      side.connect(this.sideGain);

      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = BASS_HZ;
      const high = ctx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = AIR_HZ;
      this.source.connect(low).connect(this.bassGain);
      this.source.connect(high).connect(this.airGain);
      this.source.connect(this.mixGain);

      this.reduced = ctx.createGain();
      for (const g of [this.mixGain, this.sideGain, this.bassGain, this.airGain]) g.connect(this.reduced);

      // Taps: the mix as the singer would have heard it (the melody reference),
      // and the cancelled bus, so we can tell a mono track from a stereo one.
      this.trackAnalyser = ctx.createAnalyser();
      this.trackAnalyser.fftSize = FFT;
      this.source.connect(this.trackAnalyser);
      this.sideAnalyser = ctx.createAnalyser();
      this.sideAnalyser.fftSize = 512;
      side.connect(this.sideAnalyser);

      this.reduced.connect(this.out);
      this._applyVocalGains();
    }

    // A tab that autoplayed before the graph existed can leave the context
    // suspended, which would silence the track the moment karaoke is switched on.
    const resume = () => this.ctx?.resume?.().catch(() => {});
    this.audioEl?.addEventListener('play', resume);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return ctx;
  }

  _applyVocalGains() {
    if (!this.mixGain) return;
    const g = vocalGains(this.vocalLevel);
    const t = this.ctx.currentTime;
    // Short ramps: a step on a gain node is an audible click.
    for (const [node, value] of [
      [this.mixGain, g.mix],
      [this.sideGain, g.side],
      [this.bassGain, g.bass],
      [this.airGain, g.air],
    ]) {
      node.gain.setTargetAtTime(value, t, 0.02);
    }
  }

  /** 1 = the record's singer at full volume, 0 = out of the way. */
  async setVocalLevel(level) {
    this.vocalLevel = clamp01(level);
    if (this.vocalLevel < 1 || this.ctx) await this.ensure();
    this._applyVocalGains();
    return this.vocalLevel;
  }

  async setKey(semitones) {
    const next = clampKey(semitones);
    const was = this.key;
    this.key = next;
    if (next === 0 && !this.ctx) return next;
    await this.ensure();
    if (!this.reduced) return next;
    if (next === 0) {
      if (was !== 0) {
        this.reduced.disconnect();
        this.shifter?.disconnect();
        this.reduced.connect(this.out);
      }
      return next;
    }
    const node = await this._ensureShifter();
    if (!node) {
      this.key = 0;
      this.onNotice('Key change needs AudioWorklet, which this browser does not have');
      return 0;
    }
    node.parameters.get('ratio').value = semitoneRatio(next);
    if (was === 0) {
      this.reduced.disconnect();
      this.reduced.connect(node);
      node.connect(this.out);
    }
    return next;
  }

  async _ensureShifter() {
    if (this.shifter) return this.shifter;
    if (!this.ctx.audioWorklet) return null;
    try {
      if (!this._workletReady) {
        // A Blob URL, not a file path: the desktop app runs from file://, where
        // addModule() of a relative URL is blocked.
        const url = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
        this._workletReady = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      }
      await this._workletReady;
      this.shifter = new AudioWorkletNode(this.ctx, 'pitch-shift', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      return this.shifter;
    } catch (err) {
      this._workletReady = null;
      this.onNotice(`Key change unavailable: ${err?.message || err}`);
      return null;
    }
  }

  // ------------------------------- the singer -------------------------------

  /**
   * Open the microphone without necessarily routing it to the speakers —
   * scoring needs the analyser even when the singer is on headphones with the
   * monitor muted.
   */
  async openMic({ deviceId = null } = {}) {
    await this.ensure();
    if (!this._micStream) {
      // No echo cancellation or AGC: both are tuned for speech on a call and
      // they gate a singing voice into pieces.
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) audio.deviceId = { exact: deviceId };
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio });
      const src = this.ctx.createMediaStreamSource(this._micStream);

      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = FFT;
      src.connect(this.micAnalyser); // always on — scoring works while muted

      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = 0;
      src.connect(this.monitorGain);

      this.dryGain = this.ctx.createGain();
      this.wetGain = this.ctx.createGain();
      const verb = this.ctx.createConvolver();
      verb.buffer = this._impulse();
      this.monitorGain.connect(this.dryGain).connect(this.out);
      this.monitorGain.connect(verb).connect(this.wetGain);
      this.wetGain.connect(this.out);
      this._verb = verb;
    }
    this._applyMonitorGains();
    return true;
  }

  async startMonitor(opts = {}) {
    await this.openMic(opts);
    this.monitoring = true;
    this.guard.reset();
    this._applyMonitorGains();
    return true;
  }

  stopMonitor() {
    this.monitoring = false;
    this._applyMonitorGains();
  }

  /** Release the microphone entirely (the OS indicator goes out). */
  releaseMic() {
    this.stopMonitor();
    this._micStream?.getTracks().forEach((t) => t.stop());
    this._micStream = null;
    this.micAnalyser = null;
    this.monitorGain = null;
  }

  get micOpen() {
    return !!this._micStream;
  }

  setMicLevel(v) {
    this.micLevel = clamp01(v);
    this._applyMonitorGains();
    return this.micLevel;
  }

  setReverb(v) {
    this.reverb = clamp01(v);
    this._applyMonitorGains();
    return this.reverb;
  }

  _applyMonitorGains() {
    if (!this.monitorGain) return;
    const t = this.ctx.currentTime;
    const on = this.monitoring ? 1 : 0;
    // ×2 headroom so the slider's middle is unity and singers can push past it.
    this.monitorGain.gain.setTargetAtTime(on * this.micLevel * 2, t, 0.03);
    this.dryGain.gain.setTargetAtTime(1 - this.reverb * 0.5, t, 0.03);
    this.wetGain.gain.setTargetAtTime(this.reverb, t, 0.03);
  }

  _impulse() {
    const n = Math.floor(this.ctx.sampleRate * REVERB_SECONDS);
    const buf = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * decayEnvelope(i, n);
    }
    return buf;
  }

  // -------------------------------- listening --------------------------------

  /** Latest mic samples, or null when the mic isn't open. */
  micFrame() {
    if (!this.micAnalyser) return null;
    this.micAnalyser.getFloatTimeDomainData(this._buf);
    return this._buf;
  }

  /** Latest samples of the track as recorded — vocal included. */
  trackFrame() {
    if (!this.trackAnalyser) return null;
    this.trackAnalyser.getFloatTimeDomainData(this._trackBuf);
    return this._trackBuf;
  }

  /** RMS of a node's current frame, for meters and the sing gate. */
  static levelOf(buf) {
    if (!buf?.length) return 0;
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  /**
   * Called once a frame while a song plays. Runs the howl guard and, the first
   * time it sees one, reports a track whose vocal cannot be cancelled.
   */
  watch(now = Date.now()) {
    const mic = KaraokeAudio.levelOf(this.micFrame());
    if (this.monitoring && this.guard.update(mic, now)) {
      this.setMicLevel(Math.min(this.micLevel, 0.25));
      this.onNotice('Feedback — mic turned down. Use headphones or move the mic away from the speakers.');
    }
    if (!this._warnedMono && this.vocalLevel < 1 && this.sideAnalyser) {
      const side = new Float32Array(this.sideAnalyser.fftSize);
      this.sideAnalyser.getFloatTimeDomainData(side);
      const mix = KaraokeAudio.levelOf(this.trackFrame());
      if (looksMono(mix, KaraokeAudio.levelOf(side))) {
        this._warnedMono = true;
        this.onNotice("This track is mono — its vocal can't be separated out.");
      }
    }
    return mic;
  }

  /** New song: the mono verdict was about the last one. */
  resetTrack() {
    this._warnedMono = false;
  }

  async dispose() {
    this.releaseMic();
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
