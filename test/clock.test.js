import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaClock, PredictiveClock, StreamingClock } from '../app/clock.js';

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

test('observe() does not jump backward on a modest ahead error', () => {
  const { clock, state } = makeClock();
  clock.start(0);
  state.t = 10;
  clock.observe(8.5); // 1.5s ahead — should ease, not rewind
  assert.ok(clock.now() >= 9.5, `position should not jump back, got ${clock.now()}`);
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

// Helper: a StreamingClock with a manually-advanced wall clock.
function makeStreaming(opts = {}) {
  const state = { t: 0, playing: true };
  const clock = new StreamingClock({
    isPlaying: () => state.playing,
    now: () => state.t,
    ...opts,
  });
  return { clock, state };
}

test('StreamingClock free-runs at rate 1.0 between measurements', () => {
  const { clock, state } = makeStreaming();
  clock.set(30);
  state.t = 5;
  assert.ok(Math.abs(clock.position() - 35) < 1e-9);
});

test('StreamingClock applies the device-latency lead to now()', () => {
  const { clock } = makeStreaming({ lead: 0.2 });
  clock.set(30);
  assert.ok(Math.abs(clock.now() - 30.2) < 1e-9);
});

test('StreamingClock eases toward a small poll error instead of snapping', () => {
  const { clock, state } = makeStreaming({ ease: 0.25 });
  clock.set(10);
  state.t = 2; // predicted = 12
  clock.observe(12.4); // 0.4s behind → nudge by 0.4*0.25 = 0.1
  assert.ok(Math.abs(clock.position() - 12.1) < 1e-9, 'moved a fraction, not the whole error');
});

test('StreamingClock snaps when a poll is beyond the jump threshold', () => {
  const { clock, state } = makeStreaming({ jumpThreshold: 0.75 });
  clock.set(10);
  state.t = 2; // predicted = 12
  clock.observe(45); // seek / new track
  assert.ok(Math.abs(clock.position() - 45) < 1e-9);
});

test('StreamingClock holds inside the deadband (poll noise is ignored, not chased)', () => {
  const { clock, state } = makeStreaming({ deadband: 0.15 });
  clock.set(30);
  state.t = 2; // predicted = 32
  clock.observe(32.1); // 0.1s wobble, within the deadband → no correction at all
  assert.ok(Math.abs(clock.position() - 32) < 1e-9);
});

test('StreamingClock does NOT snap on ordinary sub-1.5s poll staleness', () => {
  const { clock, state } = makeStreaming(); // production defaults (jumpThreshold 1.5)
  clock.set(10);
  state.t = 0; // predicted = 10
  clock.observe(11.2); // 1.2s stale poll — a real seek would move much further
  assert.ok(clock.position() > 10 && clock.position() < 10.5, 'eased gently, not snapped');
});

test('StreamingClock still snaps on a genuine seek beyond the threshold', () => {
  const { clock, state } = makeStreaming(); // production defaults
  clock.set(10);
  state.t = 0;
  clock.observe(25); // skipped ahead 15s → snap to truth
  assert.ok(Math.abs(clock.position() - 25) < 1e-9);
});

test('StreamingClock freezes while paused', () => {
  const { clock, state } = makeStreaming();
  clock.set(20);
  state.t = 3;
  state.playing = false;
  const frozen = clock.position();
  state.t = 100;
  assert.equal(clock.position(), frozen);
});

test('StreamingClock with an exact getPosition bypasses the ease model', () => {
  const state = { pos: 42 };
  const clock = new StreamingClock({
    isPlaying: () => true,
    getPosition: () => state.pos,
  });
  clock.observe(0); // should be ignored — exact source wins
  assert.equal(clock.position(), 42);
});

test('MediaClock reflects the underlying media element', () => {
  const el = { currentTime: 12.5, paused: false, ended: false };
  const clock = new MediaClock(el);
  assert.equal(clock.now(), 12.5);
  assert.equal(clock.isPlaying(), true);
  el.paused = true;
  assert.equal(clock.isPlaying(), false);
});
