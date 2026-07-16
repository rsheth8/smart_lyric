// Cross-provider match scoring.
//
// Every medium hands us a target track *duration* (Spotify `duration_ms`, iTunes
// `trackTimeMillis`, the decoded audio-file length, an ACRCloud match). Duration
// is the strongest disambiguator between the right recording and a wrong one that
// shares the title: a cover, a live take, a remix, a sped-up edit, or a different
// song entirely. Title similarity alone can't tell an album cut from a 6-minute
// live version — the length can. These helpers fold duration into match ranking
// and let the orchestrator reject a word-level hit that is clearly the wrong take.
//
// Durations are always in **seconds** here; callers convert (NetEase returns ms).

export const DURATION_NEAR_SEC = 2.5; // within this, treat the lengths as identical
export const DURATION_FAR_SEC = 12; // beyond this, the duration bonus is exhausted
export const DURATION_REJECT_SEC = 22; // beyond this, it's almost surely a different take

const sec = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * How well two lengths agree: 1 when within DURATION_NEAR_SEC, decaying linearly
 * to 0 by DURATION_FAR_SEC. Returns `null` when either length is unknown — callers
 * treat `null` as "no signal" rather than a zero so unknown never penalizes.
 */
export function durationScore(targetSec, candidateSec) {
  const a = sec(targetSec);
  const b = sec(candidateSec);
  if (a === null || b === null) return null;
  const off = Math.abs(a - b);
  if (off <= DURATION_NEAR_SEC) return 1;
  if (off >= DURATION_FAR_SEC) return 0;
  return 1 - (off - DURATION_NEAR_SEC) / (DURATION_FAR_SEC - DURATION_NEAR_SEC);
}

/**
 * True only when both lengths are known and grossly apart — a hard "this is the
 * wrong recording" signal used to drop an otherwise-preferred word-level hit.
 * Unknown lengths never mismatch (we stay conservative and keep the candidate).
 */
export function durationMismatch(targetSec, candidateSec) {
  const a = sec(targetSec);
  const b = sec(candidateSec);
  if (a === null || b === null) return false;
  return Math.abs(a - b) >= DURATION_REJECT_SEC;
}

/**
 * Combined rank for one candidate recording: title similarity, nudged by how well
 * the length agrees. Title stays dominant (range 0..1); duration only shifts the
 * score by ±0.3, enough to break ties between same-titled takes (album vs live vs
 * remix) and to demote a far-off length, without overriding a real title gap.
 * Unknown duration leaves the title score untouched.
 * @param {{ titleScore: number, targetDuration?: number, candidateDuration?: number }} p
 */
export function candidateScore({ titleScore, targetDuration, candidateDuration }) {
  const d = durationScore(targetDuration, candidateDuration);
  if (d === null) return titleScore;
  return titleScore + 0.6 * (d - 0.5);
}

/**
 * Pick the best lyrics result across providers. `results` is ordered by intrinsic
 * preference (richest timing first: word-level → line-level). We keep that order,
 * but when a target duration is known we skip any candidate whose length grossly
 * mismatches it — so a wrong-take word-level hit yields to a correct line-level
 * one — falling back to the raw preference order only if every candidate mismatches.
 * @param {Array<{ meta?: { duration?: number } }|null|undefined>} results preference order
 * @param {number} [targetDuration] seconds, when the medium knows it
 */
export function preferResult(results, targetDuration) {
  const present = (results || []).filter(Boolean);
  if (!present.length) return null;
  const target = sec(targetDuration);
  if (target === null) return present[0];

  const plausible = present.filter((r) => !durationMismatch(target, r.meta?.duration));
  return (plausible.length ? plausible : present)[0];
}
