import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPauseLiveSeparation,
  shouldResumeLiveSeparation,
  LIVE_SEP_MIN_REALTIME,
  LIVE_SEP_MIN_SAMPLES,
  LIVE_SEP_RETRY_AFTER_SEC,
} from '../app/align.js';

/**
 * Build stats as recordSeparation would, given per-window [audioSec, wallSec].
 * The first entry is the warm-up (model load) and must not count against us.
 */
function statsFrom(windows) {
  const s = {
    sepCount: 0,
    sepTotalSec: 0,
    sepTotalWindowSec: 0,
    firstSepSec: 0,
    firstWindowSec: 0,
    paused: false,
    pausedAtMs: null,
  };
  for (const [audioSec, wallSec] of windows) {
    s.sepCount += 1;
    s.sepTotalSec += wallSec;
    s.sepTotalWindowSec += audioSec;
    if (s.sepCount === 1) {
      s.firstSepSec = wallSec;
      s.firstWindowSec = audioSec;
    }
  }
  return s;
}

test('keeping pace comfortably never pauses', () => {
  // 3s of audio separated in 1.5s each = 2× realtime.
  const s = statsFrom([
    [3, 6],
    [3, 1.5],
    [3, 1.5],
    [3, 1.5],
  ]);
  assert.equal(shouldPauseLiveSeparation(s), false);
});

test('falling behind pauses once there is a real trend', () => {
  // 3s of audio taking 4.3s each ≈ 0.7× realtime — the reported case.
  const s = statsFrom([
    [3, 8],
    [3, 4.3],
    [3, 4.3],
    [3, 4.3],
  ]);
  assert.equal(shouldPauseLiveSeparation(s), true);
});

test('a slow WARM-UP alone does not trigger the fallback', () => {
  // The first window pays for model load (12s!) but steady state is 2× realtime.
  const s = statsFrom([
    [3, 12],
    [3, 1.5],
    [3, 1.5],
    [3, 1.5],
  ]);
  assert.equal(
    shouldPauseLiveSeparation(s),
    false,
    'model load must not be mistaken for a slow machine'
  );
});

test('too few samples to judge yet', () => {
  const s = statsFrom([
    [3, 8],
    [3, 9],
  ]);
  assert.ok(s.sepCount < LIVE_SEP_MIN_SAMPLES);
  assert.equal(shouldPauseLiveSeparation(s), false, 'wait for evidence before degrading');
});

test('the threshold is where it claims to be', () => {
  // Just above and just below LIVE_SEP_MIN_REALTIME in steady state.
  const wall = (rt) => 3 / rt;
  const above = statsFrom([[3, 8], ...Array(4).fill([3, wall(LIVE_SEP_MIN_REALTIME + 0.1)])]);
  const below = statsFrom([[3, 8], ...Array(4).fill([3, wall(LIVE_SEP_MIN_REALTIME - 0.1)])]);
  assert.equal(shouldPauseLiveSeparation(above), false);
  assert.equal(shouldPauseLiveSeparation(below), true);
});

test('degenerate stats are safe', () => {
  assert.equal(shouldPauseLiveSeparation(null), false);
  assert.equal(shouldPauseLiveSeparation({ sepCount: 9 }), false, 'no timing recorded');
  assert.equal(
    shouldPauseLiveSeparation(
      statsFrom([
        [3, 5],
        [3, 5],
      ])
    ),
    false,
    'only the warm-up sample has any weight'
  );
});

test('cool-down elapsing allows a retry', () => {
  const pausedAt = 1_000_000;
  const paused = { paused: true, pausedAtMs: pausedAt };
  assert.equal(
    shouldResumeLiveSeparation(paused, pausedAt + (LIVE_SEP_RETRY_AFTER_SEC - 1) * 1000),
    false,
    'still inside cool-down'
  );
  assert.equal(
    shouldResumeLiveSeparation(paused, pausedAt + LIVE_SEP_RETRY_AFTER_SEC * 1000),
    true,
    'retry once cool-down elapses'
  );
  assert.equal(shouldResumeLiveSeparation({ paused: false, pausedAtMs: pausedAt }, pausedAt + 60_000), false);
  assert.equal(shouldResumeLiveSeparation({ paused: true, pausedAtMs: null }, pausedAt), true);
});
