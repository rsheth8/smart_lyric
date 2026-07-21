import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEstimator } from '../app/sync-learn.js';

/** The gain curve app.js applies per correction (kept in sync with ingestTimingSamples). */
const gainFor = (mag) => (mag > 0.25 ? 0.9 : mag > 0.12 ? 0.7 : 0.45);

/** Drive the estimator like the live loop does and report how fast it lands. */
function converge(trueOffset, { samples = 12, jitter = 0, start = 0, est = new SyncEstimator() } = {}) {
  let applied = start;
  let rand = 42;
  const next = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  const trace = [];
  for (let i = 0; i < samples; i++) {
    est.addSample({ value: trueOffset + next() * jitter, score: 0.9 });
    const s = est.suggestion();
    if (s != null) {
      const err = s - applied;
      applied = Math.round((applied + err * gainFor(Math.abs(err))) * 1000) / 1000;
    }
    trace.push(+applied.toFixed(3));
  }
  return { applied, trace };
}

/** Samples needed to get within `tol` of the true offset. */
const settleAt = (trace, target, tol = 0.05) => {
  const i = trace.findIndex((v) => Math.abs(v - target) <= tol);
  return i < 0 ? Infinity : i + 1;
};

test('a large clean lag is corrected within a couple of measurements', () => {
  const { trace } = converge(0.4, { jitter: 0.01 });
  const n = settleAt(trace, 0.4);
  assert.ok(n <= 3, `should land in <=3 samples, took ${n} (${trace.slice(0, 5)})`);
});

test('a small error still converges, just more gently', () => {
  const { applied } = converge(0.06, { jitter: 0.01 });
  assert.ok(Math.abs(applied - 0.06) < 0.03, `got ${applied}`);
});

test('latency that STEPS mid-song is followed quickly (device switch)', () => {
  const est = new SyncEstimator();
  // Settle at +0.10 first.
  for (let i = 0; i < 8; i++) est.addSample({ value: 0.1, score: 0.9 });
  assert.ok(Math.abs(est.suggestion() - 0.1) < 0.02, 'locked on the original latency');
  // Now the path changes to +0.55 (e.g. Bluetooth speaker).
  let applied = 0.1;
  let n = Infinity;
  for (let i = 0; i < 8; i++) {
    est.addSample({ value: 0.55, score: 0.9 });
    const s = est.suggestion();
    if (s != null) {
      const err = s - applied;
      applied = applied + err * gainFor(Math.abs(err));
    }
    if (n === Infinity && Math.abs(applied - 0.55) <= 0.05) n = i + 1;
  }
  assert.ok(n <= 4, `should re-converge in <=4 samples, took ${n} (at ${applied.toFixed(3)})`);
});

test('scattered samples do NOT trigger a correction (noisy room)', () => {
  const est = new SyncEstimator();
  for (const v of [0.5, -0.4, 0.45, -0.35, 0.02]) est.addSample({ value: v, score: 0.9 });
  assert.equal(est.suggestion(), null, 'no consensus → stay put rather than lurch');
});

test('a big error needs less agreement than a tiny one', () => {
  const est = new SyncEstimator();
  assert.ok(
    est.requiredConfidence(0.45) < est.requiredConfidence(0.02),
    'the bar eases down as the error grows'
  );
  assert.equal(est.requiredConfidence(0.02), 0.6, 'near zero still demands consensus');
  assert.ok(est.requiredConfidence(0.45) >= 0.34, 'but never below the floor');
});

test('does not oscillate once settled', () => {
  const { trace } = converge(0.3, { jitter: 0.04, samples: 20 });
  const tail = trace.slice(-8);
  const swing = Math.max(...tail) - Math.min(...tail);
  assert.ok(swing < 0.06, `tail should be steady, swing was ${swing.toFixed(3)} (${tail})`);
});

test('regime shift keeps only the new samples', () => {
  const est = new SyncEstimator();
  for (let i = 0; i < 6; i++) est.addSample({ value: 0.05, score: 0.9 });
  for (let i = 0; i < 3; i++) est.addSample({ value: 0.6, score: 0.9 });
  assert.equal(est.count, 3, 'stale window dropped');
  assert.ok(Math.abs(est.value - 0.6) < 0.02, `value follows the new regime, got ${est.value}`);
});

// ---- noisy-but-consistent evidence must be usable -------------------------
// Reported symptom: "6 samples, 34% agree" sitting on 'converging' forever.
// Onset measurements on a dense mix scatter by more than the ±120ms agree band,
// but they still cluster around the true offset — and the MEDIAN of six such
// samples pins it better than two tidy ones. The old share-within-band metric
// could only ever DROP as samples arrived, so more evidence meant less trust.

test('mild scatter still locks — the median is what matters', () => {
  const est = new SyncEstimator();
  // Clustered at ~+0.15 with two stray probes. The strays should not veto a
  // median that six measurements agree on.
  for (const v of [0.15, 0.14, 0.16, 0.13, 0.35, -0.05]) {
    est.addSample({ value: v, score: 0.9 });
  }
  assert.ok(Math.abs(est.value - 0.15) < 0.05, `median finds the truth, got ${est.value}`);
  assert.ok(est.suggestion() != null, `should lock, confidence ${est.confidence.toFixed(2)}`);
});

test('more evidence increases confidence rather than eroding it', () => {
  const values = [0.15, 0.14, 0.16, 0.13, 0.155, 0.145];
  const few = new SyncEstimator();
  for (const v of values.slice(0, 2)) few.addSample({ value: v, score: 0.9 });
  const many = new SyncEstimator();
  for (const v of values) many.addSample({ value: v, score: 0.9 });
  assert.ok(
    many.confidence >= few.confidence,
    `six samples (${many.confidence.toFixed(2)}) must not score below two (${few.confidence.toFixed(2)})`
  );
});

// The reported "6 samples, 34% agree" case. Measurements spread over ~440ms give
// the median a standard error near the agree band itself, so REFUSING to lock is
// correct — the fix for that case is better measurements, not a lower bar.
test('genuinely scattered measurements are still refused', () => {
  const est = new SyncEstimator();
  for (const v of [0.15, 0.14, 0.34, 0.36, -0.05, -0.08]) {
    est.addSample({ value: v, score: 0.9 });
  }
  assert.equal(est.suggestion(), null, 'do not apply an offset we only know to ~100ms');
});

test('genuine disagreement is still refused no matter how many samples', () => {
  const est = new SyncEstimator();
  for (const v of [0.9, -0.8, 0.7, -0.9, 0.85, -0.75, 0.8, -0.85]) {
    est.addSample({ value: v, score: 0.9 });
  }
  assert.equal(est.suggestion(), null, 'no amount of contradictory evidence should lock');
});

// ---- warm start: provisional lock from a trusted prior --------------------
import {
  syncLockState,
  PRIOR_DISAGREE_SAMPLES,
  PRIOR_DISAGREE_BAND,
} from '../app/sync-learn.js';

const strongPrior = { value: 0.3, strong: true };

test('liveValue reflects samples only, ignoring the seeded prior', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  assert.equal(est.liveValue, null, 'no live samples yet');
  est.addSample({ value: 0.05, score: 0.9 });
  est.addSample({ value: 0.06, score: 0.9 });
  assert.ok(Math.abs(est.liveValue - 0.055) < 0.03, `live median, got ${est.liveValue}`);
});

test('a trusted prior shows locked before any live sample', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  assert.equal(syncLockState(est, { prior: strongPrior }), 'locked', 'warm start');
});

test('a few live samples that AGREE keep the memory lock', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  for (const v of [0.28, 0.31, 0.3, 0.29]) est.addSample({ value: v, score: 0.9 });
  assert.equal(syncLockState(est, { prior: strongPrior }), 'locked');
});

test('live evidence that CONTRADICTS the memory knocks it back to converging', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  // Different latency this time (e.g. switched to Bluetooth), and scattered
  // enough NOT to confirm on its own — but its centre is clearly not 0.3, so the
  // memory can no longer be trusted and we must re-earn the lock live.
  for (const v of [0.7, 0.2, 0.9, 0.45]) est.addSample({ value: v, score: 0.9 });
  assert.equal(est.suggestion(), null, 'too scattered to confirm independently');
  assert.ok(Math.abs(est.liveValue - 0.3) > PRIOR_DISAGREE_BAND, 'but clearly off the memory');
  assert.equal(syncLockState(est, { prior: strongPrior }), 'converging');
});

test('one stray sample is not enough to unseat a trusted memory', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  est.addSample({ value: 0.9, score: 0.9 }); // single outlier
  assert.ok(est.count < PRIOR_DISAGREE_SAMPLES);
  assert.equal(syncLockState(est, { prior: strongPrior }), 'locked');
});

test('a WEAK prior gives no warm start (old behaviour)', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 1 });
  assert.equal(syncLockState(est, { prior: { value: 0.3, strong: false } }), 'listening');
  est.addSample({ value: 0.3, score: 0.9 });
  assert.equal(syncLockState(est, { prior: { value: 0.3, strong: false } }), 'converging');
});

test('no prior at all behaves exactly as before', () => {
  const est = new SyncEstimator();
  assert.equal(syncLockState(est, {}), 'listening');
  est.addSample({ value: 0.3, score: 0.9 });
  assert.equal(syncLockState(est, {}), 'converging');
});

test('confirmed live measurement locks even against a disagreeing prior', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  // Tight, plentiful, and NOT 0.3 → independently confident, should lock on the
  // real value regardless of memory.
  for (let i = 0; i < 8; i++) est.addSample({ value: 0.7, score: 0.95 });
  assert.equal(syncLockState(est, { prior: strongPrior }), 'locked');
  assert.ok(Math.abs(est.value - 0.7) < 0.05, 'on the freshly-measured value');
});

test('manual takeover still wins over a warm-start lock', () => {
  const est = new SyncEstimator();
  est.seed(0.3, { weight: 2 });
  assert.equal(syncLockState(est, { prior: strongPrior, suspended: true }), 'manual');
});
