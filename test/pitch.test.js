import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPitch,
  downsample,
  midiFromHz,
  hzFromMidi,
  noteName,
  centsOff,
  centsToPitchClass,
} from '../app/pitch.js';

const SR = 48000;

/** A vowel-ish tone: fundamental plus two harmonics, like a sung note. */
function tone(hz, n = 4096, sr = SR, amp = 1) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    b[i] = amp * (0.5 * Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(4 * Math.PI * hz * t) + 0.15 * Math.sin(6 * Math.PI * hz * t));
  }
  return b;
}

const cents = (got, want) => 1200 * Math.log2(got / want);

test('detectPitch tracks the whole sung range within 15 cents', () => {
  for (const hz of [82.4, 110, 146.8, 220, 329.6, 440, 523.25, 880]) {
    const got = detectPitch(tone(hz), SR);
    assert.ok(got, `no pitch for ${hz} Hz`);
    assert.ok(Math.abs(cents(got, hz)) < 15, `${hz} Hz read as ${got.toFixed(1)} Hz`);
  }
});

test('detectPitch reports the fundamental, not a subharmonic, on high notes', () => {
  // The octave error a plain autocorrelation makes: 880 read as 440 or 176.
  const got = detectPitch(tone(880), SR);
  assert.ok(Math.abs(cents(got, 880)) < 15);
});

test('detectPitch returns null on silence and on noise', () => {
  assert.equal(detectPitch(new Float32Array(4096), SR), null);
  const noise = Float32Array.from({ length: 4096 }, () => Math.random() * 2 - 1);
  assert.equal(detectPitch(noise, SR), null);
});

test('detectPitch gates on level so room tone is not a note', () => {
  assert.equal(detectPitch(tone(220, 4096, SR, 0.001), SR), null);
  assert.ok(detectPitch(tone(220, 4096, SR, 0.5), SR));
});

test('detectPitch needs a full window', () => {
  assert.equal(detectPitch(new Float32Array(64), SR), null);
  assert.equal(detectPitch(null, SR), null);
  assert.equal(detectPitch(tone(220), 0), null);
});

test('downsample averages whole blocks and drops the remainder', () => {
  const x = Float32Array.from([1, 3, 5, 7, 9]);
  assert.deepEqual([...downsample(x, 2)], [2, 6]);
  assert.equal(downsample(x, 1), x);
});

test('midi/hz round-trip and note naming', () => {
  assert.equal(midiFromHz(440), 69);
  assert.ok(Math.abs(hzFromMidi(69) - 440) < 1e-9);
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(midiFromHz(440)), 'A4');
});

test('centsOff is signed and symmetric', () => {
  assert.ok(Math.abs(centsOff(440, 440)) < 1e-9);
  assert.ok(Math.abs(centsOff(880, 440) - 1200) < 1e-9);
  assert.ok(Math.abs(centsOff(220, 440) + 1200) < 1e-9);
});

test('centsToPitchClass folds octaves so a bass matches a soprano', () => {
  assert.ok(Math.abs(centsToPitchClass(220, 440)) < 1e-9);
  assert.ok(Math.abs(centsToPitchClass(110, 440)) < 1e-9);
  // A semitone flat is a semitone flat in any octave.
  assert.ok(Math.abs(centsToPitchClass(220 * 2 ** (-1 / 12), 440) + 100) < 1e-6);
  const c = centsToPitchClass(440 * 2 ** (7 / 12), 440);
  assert.ok(c > -600 && c <= 600, `folded to ${c}`);
  assert.equal(centsToPitchClass(0, 440), null);
  assert.equal(centsToPitchClass(440, 0), null);
});
