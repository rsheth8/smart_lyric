import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manualNudgePolicy,
  SyncEstimator,
  syncLockState,
  NUDGE_FULLY_MANUAL_AT,
} from '../app/sync-learn.js';

const nudge = (prev, deltaSec, nowMs = 0) => manualNudgePolicy(prev, { deltaSec, nowMs });

test('one nudge holds auto off briefly but does not go fully manual', () => {
  const s = nudge(null, 0.025, 1000);
  assert.equal(s.taps, 1);
  assert.equal(s.fullyManual, false);
  assert.equal(s.anchor, false);
  assert.ok(s.holdUntil > 1000, 'auto pauses applying for a bit');
});

test('nudging the same way twice anchors — the old estimate is stale', () => {
  let s = nudge(null, 0.025, 0);
  s = nudge(s, 0.025, 500);
  assert.equal(s.sameDirRun, 2);
  assert.equal(s.anchor, true, 'replace the window rather than average against the user');
});

test('reversing direction restarts the run (user is hunting, not correcting)', () => {
  let s = nudge(null, 0.025, 0);
  s = nudge(s, -0.025, 500);
  assert.equal(s.sameDirRun, 1);
  assert.equal(s.anchor, false);
});

test('persistent disagreement hands the song over', () => {
  let s = null;
  for (let i = 0; i < NUDGE_FULLY_MANUAL_AT; i++) s = nudge(s, 0.025, i * 100);
  assert.equal(s.fullyManual, true);
  assert.equal(
    syncLockState(new SyncEstimator(), { autoOn: true, suspended: s.fullyManual }),
    'manual',
    'and the chip says so'
  );
});

// The behaviour that matters: a burst of taps must teach the LANDING value, not
// the wrong values passed through on the way. app.js debounces, so the estimator
// only ever sees the final offset — modelled here.
test('a six-tap adjustment teaches one value: where the user landed', () => {
  let s = null;
  let offset = 0;
  for (let i = 0; i < 6; i++) {
    offset = Math.round((offset + 0.025) * 1000) / 1000;
    s = nudge(s, 0.025, i * 100);
  }
  const est = new SyncEstimator();
  if (s.anchor) est.anchor(offset, { weight: 3 });
  else est.addSample({ value: offset, weight: 3, score: 1, source: 'nudge' });
  assert.equal(est.count, 1, 'exactly one sample, not six');
  assert.ok(Math.abs(est.value - 0.15) < 1e-6, `taught the landing value, got ${est.value}`);
});

test('anchor replaces a disagreeing window instead of averaging with it', () => {
  const est = new SyncEstimator();
  // Auto had settled somewhere the user disagrees with.
  for (let i = 0; i < 8; i++) est.addSample({ value: 0.05, score: 0.9 });
  assert.ok(Math.abs(est.value - 0.05) < 0.02);
  est.anchor(0.4, { weight: 3 });
  assert.equal(est.count, 1);
  assert.ok(Math.abs(est.value - 0.4) < 1e-6, `user value wins outright, got ${est.value}`);
});

test('anchor rejects an out-of-range value', () => {
  const est = new SyncEstimator();
  assert.equal(est.anchor(99), false);
  assert.equal(est.count, 0);
});

// Root-cause 3 regression: auto must keep LEARNING through a nudge. Previously
// `autoTimingSuspended` made ingestTimingSamples discard everything.
test('measurements still accrue while manual control is held', () => {
  const est = new SyncEstimator();
  est.addSample({ value: 0.3, score: 0.9, source: 'nudge' });
  // Auto keeps measuring during the hold window...
  for (let i = 0; i < 3; i++) est.addSample({ value: 0.32, score: 0.9 });
  assert.ok(est.count >= 4, 'samples kept arriving rather than being dropped');
  assert.ok(est.suggestion() != null, 'so it can retake control once the hold expires');
});

test('addSample reports why a sample was rejected', () => {
  const est = new SyncEstimator();
  assert.equal(est.addSample({ value: 0.2 }), 'ok');
  assert.equal(est.addSample({ value: 9 }), 'clamped', 'beyond ±2s, not silently gone');
  assert.equal(est.addSample({ value: 'nope' }), 'nan');
  assert.equal(est.count, 1, 'only the good one landed');
});
