// Monophonic pitch detection for the singer's microphone (and, when we own the
// track's audio, for the mix we're scoring against).
//
// YIN (cumulative mean normalized difference) rather than plain autocorrelation:
// same amount of code, but it doesn't fall for the octave errors that make a
// naive peak-pick report 110 Hz for a 220 Hz note — which would read as a wrong
// note on the score card.
//
// Pure over a Float32Array, so it unit-tests without Web Audio.

import { rms } from './wav.js';

export const A4_HZ = 440;
export const A4_MIDI = 69;
// Sung fundamentals: a low bass note to a high soprano.
export const MIN_HZ = 70;
export const MAX_HZ = 1100;
// YIN's aperiodicity threshold. Below it a tau is "periodic enough" to accept.
export const YIN_THRESHOLD = 0.15;
// Above this the frame is noise/consonants, not a held note.
export const YIN_REJECT = 0.5;
// Quieter than this and there's nobody singing.
export const MIN_RMS = 0.012;
// YIN costs O(window × maxTau), so decimate to ~this before running it. 4 kHz of
// bandwidth is ample for a fundamental that never exceeds MAX_HZ.
export const WORK_RATE = 8000;

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function midiFromHz(hz) {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

export function hzFromMidi(midi) {
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

export function noteName(midi) {
  const n = Math.round(midi);
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Signed cents from `refHz` to `hz`. */
export function centsOff(hz, refHz) {
  return 1200 * Math.log2(hz / refHz);
}

/**
 * Cents to the nearest matching PITCH CLASS — octaves folded away, so a bass
 * singing along with a soprano track still counts as in tune. Result is in
 * (-600, 600].
 */
export function centsToPitchClass(hz, refHz) {
  if (!(hz > 0) || !(refHz > 0)) return null;
  let c = centsOff(hz, refHz) % 1200;
  if (c > 600) c -= 1200;
  else if (c <= -600) c += 1200;
  return c;
}

/**
 * Box-average decimation by an integer factor. Crude as an anti-alias filter,
 * but pitch only needs the fundamental to survive.
 * ponytail: box filter, swap for a proper FIR if harmonics ever confuse YIN.
 */
export function downsample(buf, factor) {
  if (factor <= 1) return buf;
  const out = new Float32Array(Math.floor(buf.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += buf[i * factor + j];
    out[i] = sum / factor;
  }
  return out;
}

/**
 * Fundamental frequency of `buf` in Hz, or null when the frame is too quiet or
 * too aperiodic to call.
 */
export function detectPitch(buf, sampleRate, opts = {}) {
  const {
    minHz = MIN_HZ,
    maxHz = MAX_HZ,
    threshold = YIN_THRESHOLD,
    reject = YIN_REJECT,
    minRms = MIN_RMS,
  } = opts;
  if (!buf?.length || !(sampleRate > 0)) return null;
  if (rms(buf) < minRms) return null;

  const factor = Math.max(1, Math.floor(sampleRate / WORK_RATE));
  const x = downsample(buf, factor);
  const rate = sampleRate / factor;

  const maxTau = Math.floor(rate / minHz);
  const minTau = Math.max(2, Math.floor(rate / maxHz));
  // YIN needs a full period of lag plus a window to compare it against.
  if (x.length < maxTau * 2 || maxTau <= minTau) return null;

  // The cumulative mean must run from tau=1, not from minTau: normalising
  // against only a handful of terms leaves short periods (high notes) with a
  // cmnd that never dips below the threshold, and YIN then reports a subharmonic.
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  let best = -1;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0, n = x.length - tau; i < n; i++) {
      const diff = x[i] - x[i + tau];
      sum += diff * diff;
    }
    running += sum;
    cmnd[tau] = running > 0 ? (sum * tau) / running : 1;
    // First dip below the threshold wins — that's the true period, not a
    // harmonic of it, which is the whole point of YIN over autocorrelation.
    if (best < 0 && tau > minTau && cmnd[tau - 1] < threshold && cmnd[tau] > cmnd[tau - 1]) {
      best = tau - 1;
    }
  }
  if (best < 0) {
    best = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
  }
  if (cmnd[best] > reject) return null;

  // Parabolic interpolation against the neighbours for sub-sample precision.
  let tau = best;
  if (best > minTau && best < maxTau) {
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const denom = 2 * (2 * b - a - c);
    if (denom !== 0) tau = best + (c - a) / denom;
  }
  const hz = rate / tau;
  return hz >= minHz && hz <= maxHz ? hz : null;
}
