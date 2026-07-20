// On-the-fly timing auto-calibration.
//
// NOT tempo/BPM — digital playback runs at rate 1.0, so the only error is a fixed
// latency between the lyric clock and what the user hears. The forced aligner
// already measures where each sung line lands in the captured audio; comparing
// that to where the lyric timeline says the line starts yields a *measured*
// timing target (in seconds):
//
//   target ≈ line.start − alignedVocalOnset   (in the display clock's frame)
//
// A positive target means show lyrics earlier (highlight was lagging the vocal).
// We collect these per-line measurements, reject outliers (a mis-aligned line or
// a lyric with a long instrumental intro shouldn't yank the offset), and converge
// on the robust center. This is the "learn as it plays" loop.

/** Median of a numeric array (returns 0 for empty). */
export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Weighted median of `{ value, weight }` samples. */
export function weightedMedian(samples) {
  const weighted = (samples || [])
    .map((s) => ({ value: Number(s.value), weight: Math.max(0, Number(s.weight) || 0) }))
    .filter((s) => Number.isFinite(s.value) && s.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!weighted.length) return 0;
  const total = weighted.reduce((sum, s) => sum + s.weight, 0);
  let acc = 0;
  for (const s of weighted) {
    acc += s.weight;
    if (acc >= total / 2) return s.value;
  }
  return weighted[weighted.length - 1].value;
}

// Manual-nudge policy. A nudge is the highest-quality signal available — a human
// listening and saying "it's off by this much" — so it should TEACH the estimator
// rather than switch it off. Previously one nudge suspended auto-timing for the
// whole song, which meant the user's own correction disabled the thing that would
// have learned from it.
export const NUDGE_DEBOUNCE_MS = 1500; // settle before recording; teach the landing value
export const NUDGE_HOLD_MS = 20000; // don't auto-apply over the user for a bit
export const NUDGE_FULLY_MANUAL_AT = 3; // persistent disagreement → hand over the song

/**
 * Fold one nudge into the manual-control state.
 * @param {{taps:number,lastDir:number,sameDirRun:number}|null} prev
 * @param {{deltaSec:number, nowMs:number, holdMs?:number, fullyManualAt?:number}} ev
 */
export function manualNudgePolicy(
  prev,
  { deltaSec, nowMs, holdMs = NUDGE_HOLD_MS, fullyManualAt = NUDGE_FULLY_MANUAL_AT } = {}
) {
  const dir = Math.sign(Number(deltaSec) || 0);
  const taps = (prev?.taps || 0) + 1;
  const sameDirRun = dir !== 0 && dir === prev?.lastDir ? (prev?.sameDirRun || 1) + 1 : 1;
  return {
    taps,
    lastDir: dir,
    sameDirRun,
    holdUntil: nowMs + holdMs,
    // Pushed the same way twice: the estimator's window describes a world that no
    // longer exists. Replace it rather than averaging the user against it.
    anchor: sameDirRun >= 2,
    fullyManual: taps >= fullyManualAt,
  };
}

export class SyncEstimator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.window=14]       real samples kept for the rolling estimate
   * @param {number} [opts.minSamples=2]    real measurements before a value is trusted
   * @param {number} [opts.agreeBand=0.12]  ± seconds counted as "agreeing" with median
   * @param {number} [opts.clamp=2]         max |offset| in seconds
   * @param {number} [opts.priorWeight=0.75] weight for the previous learned offset
   */
  constructor({
    window = 14,
    minSamples = 2,
    agreeBand = 0.12,
    clamp = 2,
    priorWeight = 0.75,
    recencyHalfLife = 4,
    regimeRun = 3,
  } = {}) {
    this.window = window;
    this.minSamples = minSamples;
    this.agreeBand = agreeBand;
    this.clamp = clamp;
    this.priorWeight = priorWeight;
    // Newer measurements outweigh older ones, so a changed playback path is
    // followed in 2-3 samples instead of half a window.
    this.recencyHalfLife = recencyHalfLife;
    this.regimeRun = regimeRun;
    this.samples = [];
    this.prior = null;
  }

  reset() {
    this.samples = [];
    this.prior = null;
  }

  /**
   * Replace the whole estimate with a known-good value (a user correction).
   * Unlike `seed`, this discards the sample window — averaging a human's answer
   * against measurements that disagreed with it just drags it back.
   */
  anchor(value, { weight = 3 } = {}) {
    const v = this._clamp(value);
    if (!Number.isFinite(v)) return false;
    this.samples = [{ value: v, weight: Math.max(0.05, Math.min(3, weight)), score: 1, source: 'anchor', prior: false }];
    this.prior = null;
    return true;
  }

  /** Seed with a remembered offset. It informs the estimate but cannot lock alone. */
  seed(offset, { weight = this.priorWeight } = {}) {
    const value = this._clamp(offset);
    const w = Number(weight);
    if (!Number.isFinite(value) || !Number.isFinite(w) || w <= 0) return;
    this.prior = { value, weight: Math.min(2, w), source: 'prior', prior: true };
  }

  /**
   * Feed one measured target (seconds). Also accepts:
   *   { value, weight, score, source }
   * `score` lets CTC/onset confidence shape convergence speed.
   */
  addSample(target, opts = {}) {
    const input =
      target && typeof target === 'object'
        ? target
        : { value: target, ...opts };
    const raw = Number(input.value);
    const value = this._clamp(input.value);
    // Out-of-range measurements used to vanish without trace, so a systematically
    // wrong reading looked identical to no reading at all. Report which it was.
    if (!Number.isFinite(value)) return Number.isFinite(raw) ? 'clamped' : 'nan';
    const score = Number.isFinite(Number(input.score)) ? Math.max(0, Math.min(1, Number(input.score))) : 1;
    const baseWeight = Number.isFinite(Number(input.weight)) ? Number(input.weight) : 1;
    const weight = Math.max(0.05, Math.min(3, baseWeight * (0.35 + score * 0.65)));
    this.samples.push({
      value,
      weight,
      score,
      source: input.source || 'measured',
      prior: false,
    });
    this._maybeRegimeShift();
    if (this.samples.length > this.window) this.samples.shift();
    return 'ok';
  }

  /**
   * Step-change detector. When the newest run of measurements all land far on the
   * SAME side of the older ones, latency genuinely moved (output device switched,
   * a new song whose catalog sits elsewhere, or a bad early lock) — the old window
   * describes a world that no longer exists. Dropping it re-converges in a few
   * samples instead of dragging a stale median, which is what used to force the
   * user to dial it in by hand.
   */
  _maybeRegimeShift() {
    const run = this.regimeRun;
    if (this.samples.length < run * 2) return;
    const recent = this.samples.slice(-run);
    const older = this.samples.slice(0, -run);
    const oldMid = weightedMedian(older);
    const far = 2 * this.agreeBand;
    const allAbove = recent.every((s) => s.value - oldMid > far);
    const allBelow = recent.every((s) => oldMid - s.value > far);
    if (allAbove || allBelow) {
      this.samples = recent;
      this.prior = null; // the remembered offset described the old regime too
    }
  }

  get count() {
    return this.samples.length;
  }

  get weightedCount() {
    return this._allSamples().reduce((sum, s) => sum + s.weight, 0);
  }

  /** Robust center of the current samples (median), clamped. */
  get value() {
    return this._clamp(weightedMedian(this._allSamples()));
  }

  /**
   * 0..1 — how much the samples agree. Low agreement (a noisy room mic, a wrong
   * take) keeps us from auto-applying a bad value.
   */
  get confidence() {
    if (this.samples.length < this.minSamples) return 0;
    const mid = weightedMedian(this.samples);
    const total = this.samples.reduce((sum, s) => sum + s.weight, 0);
    if (!total) return 0;
    const agree = this.samples
      .filter((s) => Math.abs(s.value - mid) <= this.agreeBand)
      .reduce((sum, s) => sum + s.weight, 0);
    const agreement = agree / total;
    const maturity = Math.min(1, this.samples.length / Math.max(1, this.minSamples + 1));
    return Math.min(1, agreement * (0.75 + maturity * 0.25));
  }

  /**
   * The offset to apply, or null when we shouldn't (yet).
   * @param {number} [minConfidence=0.6]
   * @returns {number|null}
   */
  suggestion(minConfidence = 0.6) {
    if (this.samples.length < this.minSamples) return null;
    const value = this.value;
    if (this.confidence < this.requiredConfidence(value, minConfidence)) return null;
    return value;
  }

  /**
   * How much agreement we demand before acting, eased down by error size. A
   * listener fixes an obvious half-second lag on the first clear cue rather than
   * gathering proof; only near-zero corrections need real consensus.
   */
  requiredConfidence(value, base = 0.6) {
    const mag = Math.abs(Number(value) || 0);
    if (mag <= 0.08) return base;
    const eased = Math.min(1, (mag - 0.08) / 0.32); // 80ms → 400ms
    return Math.max(0.34, base - eased * (base - 0.34));
  }

  _allSamples() {
    const n = this.samples.length;
    const decayed = this.samples.map((s, i) => ({
      ...s,
      weight: s.weight * Math.pow(0.5, (n - 1 - i) / this.recencyHalfLife),
    }));
    return this.prior ? [this.prior, ...decayed] : decayed;
  }

  _clamp(sec) {
    const n = Math.round(Number(sec) * 1000) / 1000;
    if (!Number.isFinite(n) || Math.abs(n) > this.clamp) return NaN;
    return Math.max(-this.clamp, Math.min(this.clamp, n));
  }
}

/**
 * UI state for the mic auto-timing loop.
 * @returns {'off'|'manual'|'listening'|'converging'|'locked'}
 */
export function syncLockState(estimator, { autoOn = true, suspended = false, lockConfidence = 0.6 } = {}) {
  if (!autoOn) return 'off';
  if (suspended) return 'manual';
  if (!estimator) return 'listening';
  if (estimator.suggestion(lockConfidence) != null && estimator.confidence >= lockConfidence) {
    return 'locked';
  }
  if (estimator.count >= 1) return 'converging';
  return 'listening';
}

/**
 * Live "am I on time right now" readout for the drift meter. The aligner measures
 * where the vocal actually lands vs the timeline (`measuredSec`, the estimator's
 * smoothed value); `appliedOffsetSec` is the correction currently applied. The
 * residual between them is what the viewer actually sees:
 *   residual > 0  → the highlight lands AFTER the vocal (lyrics running late)
 *   residual < 0  → the highlight lands BEFORE the vocal (lyrics running early)
 * Within `tolSec` (and enough confident samples) we call it in sync. Pure so it's
 * unit-testable and the UI just renders the result.
 * @returns {{status:'idle'|'listening'|'insync'|'late'|'early', residualSec:number, magnitudeMs:number}}
 */
export function driftReadout({
  measuredSec,
  appliedOffsetSec = 0,
  confidence = 0,
  count = 0,
  minSamples = 3,
  minConfidence = 0.5,
  tolSec = 0.08,
} = {}) {
  if (!count) return { status: 'idle', residualSec: 0, magnitudeMs: 0 };
  const residual = (Number(measuredSec) || 0) - (Number(appliedOffsetSec) || 0);
  const magnitudeMs = Math.round(Math.abs(residual) * 1000);
  if (count < minSamples || confidence < minConfidence) {
    return { status: 'listening', residualSec: residual, magnitudeMs };
  }
  if (Math.abs(residual) <= tolSec) return { status: 'insync', residualSec: residual, magnitudeMs: 0 };
  return { status: residual > 0 ? 'late' : 'early', residualSec: residual, magnitudeMs };
}
