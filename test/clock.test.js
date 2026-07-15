import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaClock, PredictiveClock } from '../app/clock.js';

// Helper: a PredictiveClock with a manually-advanced wall clock.
function makeClock(opts = {}) {
  const state = { t: 0 };
  const clock = new PredictiveClock({ now: () => state.t, ...opts });
  return { clock, state };
}

test('advances at the playback rate after start', () => {
  const { clock, state } = makeClock();
  state.t = 100;
  clock.start(0);
  state.t = 105;
  assert.ok(Math.abs(clock.now() - 5) < 1e-6);
});

test('respects a non-unity rate', () => {
  const { clock, state } = makeClock({ rate: 1.01 });
  state.t = 0;
  clock.start(0);
  state.t = 100;
  assert.ok(Math.abs(clock.now() - 101) < 1e-6);
});

test('pause freezes the reported position', () => {
  const { clock, state } = makeClock();
  clock.start(0);
  state.t = 10;
  clock.pause();
  const frozen = clock.now();
  state.t = 500;
  assert.equal(clock.now(), frozen);
  assert.equal(clock.isPlaying(), false);
});

test('observe() snaps when the error exceeds the jump threshold', () => {
  const { clock, state } = makeClock();
  clock.start(0);
  state.t = 10; // predicted position ~10
  clock.observe(30); // needle dropped elsewhere: +20s error
  state.t = 11;
  assert.ok(Math.abs(clock.now() - 31) < 1e-6, 'jumped to the measured position');
});

test('observe() nudges the rate for small drift instead of jumping', () => {
  const { clock, state } = makeClock();
  clock.start(0);
  state.t = 10;
  clock.observe(10.4); // we're 0.4s behind the music
  // Correction window is 4s → target rate biases up by 0.4/4 = 0.1.
  assert.ok(Math.abs(clock._targetRate - 1.1) < 1e-9);
  // And the reported position should not have jumped.
  assert.ok(Math.abs(clock.now() - 10) < 0.05);
});

test('a small drift is absorbed over time (converges toward truth)', () => {
  const { clock, state } = makeClock();
  clock.start(0);
  state.t = 10;
  const before = Math.abs(clock.now() - 10.4);
  clock.observe(10.4);
  // Advance a few seconds, sampling like a render loop would.
  for (let i = 1; i <= 240; i++) {
    state.t = 10 + i / 60;
    clock.now();
  }
  const truthNow = 10.4 + 4; // the music at t=14
  const after = Math.abs(clock.now() - truthNow);
  assert.ok(after < before, 'drift shrank after correction');
});

test('observe() on a stopped clock just starts it at that position', () => {
  const { clock, state } = makeClock();
  state.t = 3;
  clock.observe(42);
  assert.equal(clock.isPlaying(), true);
  assert.ok(Math.abs(clock.now() - 42) < 1e-6);
});

test('calibrateRate() estimates vinyl speed from two measurements', () => {
  const { clock } = makeClock();
  clock.calibrateRate(0, 0, 10.1, 10); // 10.1 song-seconds in 10 wall-seconds
  assert.ok(Math.abs(clock._targetRate - 1.01) < 1e-9);
});

test('MediaClock reflects the underlying media element', () => {
  const el = { currentTime: 12.5, paused: false, ended: false };
  const clock = new MediaClock(el);
  assert.equal(clock.now(), 12.5);
  assert.equal(clock.isPlaying(), true);
  el.paused = true;
  assert.equal(clock.isPlaying(), false);
});
