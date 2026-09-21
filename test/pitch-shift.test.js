import test from 'node:test';
import assert from 'node:assert/strict';
import { createShifter, shiftInto, bestOffset } from '../app/pitch-shift.js';
import { detectPitch } from '../app/pitch.js';

const SR = 48000;
const QUANTUM = 128;

/** Run `seconds` of a harmonic tone through the shifter and keep the steady state. */
function shift(hz, semitones, seconds = 3) {
  const ratio = 2 ** (semitones / 12);
  const state = createShifter({});
  const total = SR * seconds;
  const out = new Float32Array(total);
  const block = new Float32Array(QUANTUM);
  const ob = new Float32Array(QUANTUM);
  let n = 0;
  while (n < total) {
    for (let i = 0; i < QUANTUM; i++) {
      const t = (n + i) / SR;
      block[i] = 0.5 * Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t);
    }
    shiftInto(state, block, ob, ratio);
    out.set(ob, n);
    n += QUANTUM;
  }
  return out.subarray(SR); // drop the first second: priming + settle
}

/** Median detected pitch across the steady state, in cents from `want`. */
function medianCents(signal, want) {
  const errs = [];
  for (let o = 0; o + 8192 <= signal.length; o += 8192) {
    const hz = detectPitch(signal.subarray(o, o + 8192), SR);
    if (hz) errs.push(1200 * Math.log2(hz / want));
  }
  assert.ok(errs.length >= 4, 'shifter produced too little usable audio');
  errs.sort((a, b) => a - b);
  return errs[errs.length >> 1];
}

test('shiftInto transposes by the requested interval, within 20 cents', () => {
  // The whole reason SOLA replaced a fixed-offset crossfade: that design landed
  // 28+ cents flat here, which is a quarter tone off-key.
  for (const semis of [1, 2, 3, 4, 5, 7, -1, -2, -3, -4, -5, -7]) {
    const want = 220 * 2 ** (semis / 12);
    const err = medianCents(shift(220, semis), want);
    assert.ok(Math.abs(err) < 20, `${semis} semitones landed ${err.toFixed(1)} cents off`);
  }
});

test('an octave up and down both land on the octave', () => {
  assert.ok(Math.abs(medianCents(shift(220, 12), 440)) < 20);
  assert.ok(Math.abs(medianCents(shift(220, -12), 110)) < 20);
});

test('ratio 1 passes the tone through unchanged', () => {
  assert.ok(Math.abs(medianCents(shift(220, 0), 220)) < 10);
});

test('output stays bounded — no runaway gain or NaN', () => {
  const out = shift(220, 3);
  let peak = 0;
  for (const v of out) {
    assert.ok(Number.isFinite(v));
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak > 0.1 && peak < 2, `peak ${peak}`);
});

test('a silent input yields silence, not a click train', () => {
  const state = createShifter({});
  const ob = new Float32Array(QUANTUM);
  const silence = new Float32Array(QUANTUM);
  for (let i = 0; i < 400; i++) shiftInto(state, silence, ob, 1.2);
  assert.ok(ob.every((v) => v === 0));
});

test('a missing input block is treated as silence rather than throwing', () => {
  const state = createShifter({});
  const ob = new Float32Array(QUANTUM);
  assert.doesNotThrow(() => shiftInto(state, null, ob, 1.2));
});

test('bestOffset finds the phase-aligned splice', () => {
  // A sine whose period is 100 samples: the aligned offset is a whole period.
  const n = 4096;
  const sig = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / 100));
  // tail is sig[0..O); the candidate starts a quarter period out of phase.
  const off = bestOffset(sig, 0, sig, 25, 256, 400, 1);
  // 25 + off should be a multiple of 100 → off ≈ 75 or 175 or …
  assert.ok((25 + off) % 100 < 4 || (25 + off) % 100 > 96, `offset ${off} is not phase-aligned`);
});

test('shifter survives a long run without drifting out of its buffers', () => {
  const state = createShifter({});
  const block = new Float32Array(QUANTUM).fill(0.2);
  const ob = new Float32Array(QUANTUM);
  for (let i = 0; i < 20000; i++) shiftInto(state, block, ob, 1.5);
  assert.ok(state.inLen <= state.cap && state.outLen <= state.cap);
  assert.ok(Number.isFinite(state.outPos) && state.outPos >= 0);
});
