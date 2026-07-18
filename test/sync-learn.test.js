import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  weightedMedian,
  SyncEstimator,
  syncLockState,
  driftReadout,
} from '../app/sync-learn.js';

describe('median', () => {
  test('handles odd and even counts', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });
});

describe('weightedMedian', () => {
  test('lets high-confidence samples dominate low-confidence noise', () => {
    const v = weightedMedian([
      { value: 1.5, weight: 0.2 },
      { value: -0.4, weight: 2 },
      { value: -0.42, weight: 2 },
    ]);
    assert.ok(v < -0.35 && v > -0.45);
  });
});

describe('SyncEstimator', () => {
  test('needs minSamples before suggesting', () => {
    const e = new SyncEstimator({ minSamples: 5 });
    e.addSample(-0.8);
    e.addSample(-0.82);
    assert.equal(e.suggestion(), null);
    assert.equal(e.confidence, 0);
  });

  test('converges to the median latency and reports high confidence', () => {
    const e = new SyncEstimator();
    for (const s of [-0.80, -0.82, -0.78, -0.81, -0.79, -0.80]) e.addSample(s);
    const v = e.suggestion();
    assert.ok(v < -0.75 && v > -0.85, `got ${v}`);
    assert.ok(e.confidence >= 0.6);
  });

  test('a remembered prior helps value but cannot suggest without real samples', () => {
    const e = new SyncEstimator({ minSamples: 2 });
    e.seed(-0.7);
    assert.equal(e.count, 0);
    assert.equal(e.suggestion(), null);
    e.addSample({ value: -0.72, score: 0.9, weight: 2 });
    assert.equal(e.suggestion(), null);
    e.addSample({ value: -0.68, score: 0.9, weight: 2 });
    assert.ok(e.suggestion() < -0.65 && e.suggestion() > -0.75);
  });

  test('weighted low-score outliers do not beat confident samples', () => {
    const e = new SyncEstimator({ minSamples: 2 });
    e.addSample({ value: -0.5, score: 0.95, weight: 2 });
    e.addSample({ value: -0.52, score: 0.95, weight: 2 });
    e.addSample({ value: 1.2, score: 0.1, weight: 0.25 });
    assert.ok(e.suggestion() < -0.45 && e.suggestion() > -0.56);
  });

  test('outliers do not swing the estimate (robust median)', () => {
    const e = new SyncEstimator();
    for (const s of [-0.5, -0.52, -0.48, -0.51, -0.49]) e.addSample(s);
    e.addSample(1.9); // one wildly wrong line
    const v = e.value;
    assert.ok(v < -0.45 && v > -0.55, `median resisted outlier: ${v}`);
  });

  test('ignores non-finite and out-of-clamp samples', () => {
    const e = new SyncEstimator({ clamp: 2 });
    e.addSample(NaN);
    e.addSample(9); // beyond clamp
    e.addSample(Infinity);
    assert.equal(e.count, 0);
  });

  test('low agreement keeps confidence down (noisy source)', () => {
    const e = new SyncEstimator({ minSamples: 5, agreeBand: 0.05 });
    for (const s of [-0.2, 0.4, -0.6, 0.1, -0.9]) e.addSample(s);
    assert.ok(e.confidence < 0.6);
    assert.equal(e.suggestion(0.6), null);
  });

  test('rolling window drops old samples', () => {
    const e = new SyncEstimator({ window: 3 });
    e.addSample(-1);
    e.addSample(-1);
    e.addSample(-1);
    e.addSample(-0.2);
    assert.equal(e.count, 3);
  });
});

describe('syncLockState', () => {
  test('reports listening → converging → locked', () => {
    const e = new SyncEstimator({ minSamples: 2 });
    assert.equal(syncLockState(e, { autoOn: false }), 'off');
    assert.equal(syncLockState(e, { autoOn: true, suspended: true }), 'manual');
    assert.equal(syncLockState(e, { autoOn: true }), 'listening');
    e.addSample(-0.5);
    assert.equal(syncLockState(e, { autoOn: true }), 'converging');
    e.addSample(-0.52);
    e.addSample(-0.48);
    assert.equal(syncLockState(e, { autoOn: true }), 'locked');
  });
});

describe('driftReadout', () => {
  test('idle with no samples, listening before enough confidence', () => {
    assert.equal(driftReadout({ count: 0 }).status, 'idle');
    assert.equal(driftReadout({ count: 2, confidence: 0.9, measuredSec: 0.3 }).status, 'listening');
    assert.equal(driftReadout({ count: 5, confidence: 0.2, measuredSec: 0.3 }).status, 'listening');
  });

  test('in sync when the applied offset matches the measured drift', () => {
    const r = driftReadout({ measuredSec: 0.3, appliedOffsetSec: 0.3, confidence: 0.8, count: 5 });
    assert.equal(r.status, 'insync');
    assert.equal(r.magnitudeMs, 0);
  });

  test('late when under-corrected, early when over-corrected (with magnitude)', () => {
    const late = driftReadout({ measuredSec: 0.5, appliedOffsetSec: 0.2, confidence: 0.8, count: 5 });
    assert.equal(late.status, 'late');
    assert.equal(late.magnitudeMs, 300);
    const early = driftReadout({ measuredSec: 0.0, appliedOffsetSec: 0.2, confidence: 0.8, count: 5 });
    assert.equal(early.status, 'early');
    assert.equal(early.magnitudeMs, 200);
  });

  test('small residual within tolerance still reads in sync', () => {
    assert.equal(
      driftReadout({ measuredSec: 0.24, appliedOffsetSec: 0.2, confidence: 0.8, count: 5 }).status,
      'insync'
    );
  });
});
