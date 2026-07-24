import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEstimator } from '../app/sync-learn.js';

// The regime-shift detector exists so a genuine change of playback path (laptop
// speakers → Bluetooth) re-converges in a few samples instead of dragging a
// stale median. Its trigger used to be a FIXED 2×agreeBand (240ms), which is a
// large jump for a clean signal but pure chance for a noisy one. Measured on a
// real song, raw-mix onset probes scatter ~900ms, and three consecutive samples
// landing the same side of the median fired the detector 9 times in 240s. Each
// false fire discarded the window and kept the 3 samples that — by the trigger's
// own definition — agree with each other, so spread collapsed and the loop
// reported a confident lock on a local run of wrong readings.
//
// The bar therefore scales with the observed spread (REGIME_MAD_K × MAD).

const feed = (est, values) => values.forEach((v) => est.addSample(v));

test('a real device change still resets the window', () => {
  const est = new SyncEstimator();
  // Tight cluster near 0 (clean signal), then a decisive jump to ~0.6s.
  feed(est, [0.0, 0.01, -0.01, 0.0, 0.01, 0.0]);
  assert.ok(est.count >= 6, 'window built up');
  feed(est, [0.6, 0.61, 0.59]);
  assert.equal(est.count, 3, 'a clean, decisive jump must still truncate the window');
  assert.ok(Math.abs(est.value - 0.6) < 0.05, `should follow to the new regime, got ${est.value}`);
});

test('noise does not trigger a regime shift', () => {
  const est = new SyncEstimator();
  // Wide scatter around 0 — the real behaviour of raw-mix onset probes.
  feed(est, [-0.9, 0.8, -0.7, 0.9, -0.8, 0.7]);
  const before = est.count;
  // Three samples that all happen to land on the same side. Under the old fixed
  // 240ms bar this truncated the window; against a ~0.8s spread it is noise.
  feed(est, [0.5, 0.45, 0.55]);
  assert.ok(
    est.count > 3,
    `noise must not discard the window (had ${before}, now ${est.count})`
  );
});

// KNOWN GAP (not fixed here): even with the noisy window correctly retained,
// `suggestion()` still returns a value. Two separate mechanisms let it through —
// `requiredConfidence` eases the bar to its 0.34 floor for large offsets, and
// `value` uses recency-DECAYED weights while `confidence` measures spread on the
// UNDECAYED window. So the reported offset can track the newest few samples
// while the confidence number describes a different, wider set. Fixing that is a
// change to the confidence model, not to regime detection, and it needs its own
// before/after measurement (scripts/live-sync-check.mjs).
test('KNOWN GAP: a retained noisy window still yields a suggestion', () => {
  const est = new SyncEstimator();
  feed(est, [-0.9, 0.8, -0.7, 0.9, -0.8, 0.7]);
  feed(est, [0.5, 0.45, 0.55]);
  assert.notEqual(est.suggestion(), null, 'documents current behaviour — see comment above');
});
