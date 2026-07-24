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

// How many multiples of the observed spread (MAD) a run of new samples must
// clear before it counts as a genuine change of playback path rather than noise.
export const REGIME_MAD_K = 2;

// Cheap energy-onset probes, demoted once true CTC alignment evidence is in the
// window (see _decayedSamples). Not zero: before any CTC sample arrives these
// are the ONLY measurements available, and they still corroborate afterwards.
export const ONSET_SOURCES = new Set(['onset', 'onset-word']);
export const ONSET_DEMOTE = 0.25;

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
    // The bar has to scale with how noisy the measurements actually are.
    //
    // A fixed `2 * agreeBand` (240ms) is a big jump for a clean signal but pure
    // chance for a dirty one: with raw-mix onset probes scattering ~900ms, three
    // consecutive samples landing the same side of the median happens constantly.
    // Each false trigger threw away the whole window and kept the 3 samples that
    // — by the trigger's own definition — agree with each other, so the spread
    // collapsed, confidence spiked, and the loop "locked" onto a local run of
    // wrong readings. Measured on a real song: 9 spurious shifts in 240s and 0%
    // of locked frames within 80ms of truth. Scaling by the observed spread
    // keeps genuine device changes detectable while noise no longer qualifies.
    const olderDevs = older.map((s) => Math.abs(s.value - oldMid)).sort((a, b) => a - b);
    const olderMad = olderDevs[olderDevs.length >> 1] ?? 0;
    const far = Math.max(2 * this.agreeBand, REGIME_MAD_K * olderMad);
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
    const n = this.samples.length;
    if (n < this.minSamples) return 0;
    const mid = weightedMedian(this.samples);

    // How well do we know the MEDIAN — not what fraction of samples are tidy.
    //
    // This used to be "share of weight within agreeBand of the median", which
    // meant every extra measurement could only ever lower confidence. That is
    // backwards: the median of six noisy samples pins the true value better than
    // the median of two tight ones, because averaging is how you beat noise. The
    // practical effect was that adding more probes per line made the estimator
    // LESS willing to lock, and it sat on "converging" indefinitely.
    //
    // So: robust spread (median absolute deviation) → standard error of the
    // median (~1.253·σ/√n) → confident once that error sits comfortably inside
    // the band we'd call "in sync". Scatter still hurts, but more evidence helps.
    // Deliberately an UNWEIGHTED MAD over the raw window, even though `value`
    // is recency-weighted and source-demoted. Matching them was tried and
    // reverted: a weighted MAD around a weighted median collapses on bimodal
    // data (alternating ±0.8s samples produced MAD 0.15s and a confident, wrong
    // lock) because it measures the spread of whichever cluster carries the
    // most weight rather than the disagreement between clusters. Sources
    // disagreeing IS uncertainty, and confidence has to keep reporting it.
    const devs = this.samples.map((s) => Math.abs(s.value - mid)).sort((a, b) => a - b);
    const mad = devs[devs.length >> 1] ?? 0;
    const sem = (1.253 * mad) / Math.sqrt(n);
    const precision = 1 - sem / this.agreeBand;
    // Still want a couple of measurements before treating agreement as meaningful.
    const maturity = Math.min(1, n / Math.max(1, this.minSamples + 1));
    return Math.max(0, Math.min(1, precision * (0.85 + 0.15 * maturity)));
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

  _decayedSamples() {
    const n = this.samples.length;
    // Energy-onset probes and CTC alignment are not interchangeable evidence.
    // Measured against a known injected latency, CTC lands ~2x closer with ~2x
    // less scatter (err 0.195s / MAD 0.279s vs 0.417s / 0.630s). But onset
    // probes are far more numerous, so at the shipped per-sample weights the
    // two sources carried near-identical TOTAL weight (36x0.75 vs 11x2.25) —
    // the worse measurement got an equal vote. Once real alignment evidence
    // exists, demote the cheap proxy instead of averaging it in as an equal.
    const hasCtc = this.samples.some((s) => s.source === 'ctc');
    return this.samples.map((s, i) => {
      const recency = Math.pow(0.5, (n - 1 - i) / this.recencyHalfLife);
      const demote = hasCtc && ONSET_SOURCES.has(s.source) ? ONSET_DEMOTE : 1;
      return { ...s, weight: s.weight * recency * demote };
    });
  }

  _allSamples() {
    const decayed = this._decayedSamples();
    return this.prior ? [this.prior, ...decayed] : decayed;
  }

  /**
   * Median of the LIVE samples only (excluding any seeded prior). Null until we
   * have real measurements. Used to ask "does fresh evidence disagree with the
   * remembered offset?" — which a prior-blended `value` can't answer, since the
   * prior would pull it toward agreement by construction.
   */
  get liveValue() {
    if (!this.samples.length) return null;
    return this._clamp(weightedMedian(this._decayedSamples()));
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
// Warm start: how much live evidence, and how far off, before a trusted memory
// is treated as contradicted. A couple of scattered samples shouldn't unseat a
// value we tuned last time; a run of them that genuinely disagrees should.
export const PRIOR_DISAGREE_SAMPLES = 3;
export const PRIOR_DISAGREE_BAND = 0.15;

export function syncLockState(
  estimator,
  { autoOn = true, suspended = false, lockConfidence = 0.6, prior = null } = {}
) {
  if (!autoOn) return 'off';
  if (suspended) return 'manual';
  if (!estimator) return 'listening';
  // Confirmed live: suggestion() already applies the eased confidence bar
  // (large lags need less agreement). A second hard `confidence >= 0.6` check
  // used to keep the chip on "converging" while the offset was already applying.
  if (estimator.suggestion(lockConfidence) != null) {
    return 'locked';
  }
  // Warm start: a remembered offset we trust (this track, or a well-learned
  // device default) counts as a provisional lock — the timing is already applied
  // — and holds until live evidence actively contradicts it. This is what makes
  // a song you've played before feel locked from the first line instead of
  // sitting on "converging" while it re-earns what it already knew.
  if (prior?.strong && Number.isFinite(prior.value)) {
    const live = estimator.liveValue;
    if (live == null || estimator.count < PRIOR_DISAGREE_SAMPLES) return 'locked';
    if (Math.abs(live - prior.value) <= PRIOR_DISAGREE_BAND) return 'locked';
    return 'converging'; // memory and reality disagree — re-earn the lock live
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
