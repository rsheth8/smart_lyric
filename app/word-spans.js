// Word placement: turning raw CTC spans into the timing the display actually uses.
//
// Split out of align.js so it can be exercised without audio, without Electron
// and without a DOM. Everything here is pure: it takes a line, the aligner's
// spans for that line, and small callbacks that answer questions about the
// audio (`snap`, `onsetsIn`, `voiceEndIn`). align.js owns the audio, the IPC and
// the batching; this file owns where the words go.
//
// That split matters for measurement as much as for testing. Scoring raw CTC
// output against ground truth scores a thing the app never renders — the
// refinements below (re-anchor, interpolate, snap, honest ends) are between the
// model and the screen, and they are most of the difference.

import { syllableCount } from './providers/formats/lrc.js';

/** Below this score the alignment is a guess — interpolate instead of trusting it. */
export const MIN_WORD_SCORE = 0.3;
// When fewer than this fraction of a line's words were confidently aligned (the
// rest interpolated), we don't trust the per-word timing — the display degrades
// that line to a line-level highlight instead of a jittery word-by-word claim.
export const UNCERTAIN_COVERAGE = 0.6;
// Gaps shorter than this keep the karaoke wipe continuous; longer ones are real
// pauses and the word is allowed to end honestly instead of faking a hold.
export const GAP_TOLERANCE_SEC = 0.35;

// Guards for back-extrapolating a line whose first word isn't a confident CTC
// anchor (see applyWordSpans step 2). Bound the inferred pace and how far back
// we're ever willing to drag a line start.
export const SEC_PER_WEIGHT_MIN = 0.05;
export const SEC_PER_WEIGHT_MAX = 0.5;
export const MAX_LEAD_EXTRAPOLATION_SEC = 1.2;

export const clampT = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** How much of a line's span a word deserves. The constant keeps one-syllable
 *  words from collapsing to nothing next to a long one. */
export const wordWeight = (w) => 0.4 + syllableCount(w?.text || '');

/**
 * Seconds per syllable-weight unit — this line's local singing pace. Measured
 * between the outer CTC anchors when there are two (the real observed tempo for
 * this line); otherwise spread the catalog line span across all its words.
 */
export function secPerWeight(words, anchors, lineStart, lineEnd) {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (last.i > first.i && last.start > first.start) {
    let w = 0;
    for (let k = first.i; k < last.i; k++) w += wordWeight(words[k]);
    if (w > 0) return clampT((last.start - first.start) / w, SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX);
  }
  let total = 0;
  for (const w of words) total += wordWeight(w);
  const span = lineEnd - lineStart;
  if (total > 0 && span > 0) return clampT(span / total, SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX);
  return 0.25;
}

/**
 * Pull evenly-spread guesses onto real syllable attacks, in order. A word with no
 * plausible attack nearby keeps its interpolated time, so this can only sharpen
 * placement — never invent it. Exported for testing.
 */
export function fitToOnsets(guess, onsets, tA, tB) {
  const n = guess.length;
  if (!n || !onsets?.length) return guess;
  const cand = onsets.filter((t) => t > tA + 0.02 && t < tB - 0.02);
  const c = cand.length;
  // Fewer attacks than words means we can't see where every word went (a slurred
  // run, a quiet passage). Redistributing on partial evidence risks being worse
  // than the even spread, so keep it.
  if (c < n) return guess;
  if (c === n) return cand.slice();

  // More attacks than words (melisma — one word carried over several attacks).
  // Choose n of them, in order, minimising total displacement from the guesses.
  // Deliberately NOT distance-capped: rubato moves words far from an even spread,
  // and that displacement is the signal, not noise. Order is what keeps it sane.
  const INF = Infinity;
  const cost = Array.from({ length: n }, () => new Float64Array(c).fill(INF));
  const back = Array.from({ length: n }, () => new Int32Array(c).fill(-1));
  for (let j = 0; j < c; j++) cost[0][j] = Math.abs(cand[j] - guess[0]);
  for (let m = 1; m < n; m++) {
    let bestPrev = INF;
    let bestIdx = -1;
    for (let j = 0; j < c; j++) {
      if (j > 0 && cost[m - 1][j - 1] < bestPrev) {
        bestPrev = cost[m - 1][j - 1];
        bestIdx = j - 1;
      }
      if (bestIdx >= 0) {
        cost[m][j] = bestPrev + Math.abs(cand[j] - guess[m]);
        back[m][j] = bestIdx;
      }
    }
  }
  let end = -1;
  let bestTotal = INF;
  for (let j = 0; j < c; j++) {
    if (cost[n - 1][j] < bestTotal) {
      bestTotal = cost[n - 1][j];
      end = j;
    }
  }
  if (end < 0) return guess;
  const out = new Array(n);
  for (let m = n - 1; m >= 0 && end >= 0; m--) {
    out[m] = cand[end];
    end = back[m][end];
  }
  return out.every((v) => Number.isFinite(v)) ? out : guess;
}

/**
 * Apply aligned CTC word spans onto one line's word objects, in place. Beyond raw
 * CTC this (1) re-anchors line.start to the first confident vocal onset — bounded
 * below by `floorSec` (the previous line's end) so lines stay ordered; (2) keeps
 * confident words as anchors and interpolates the uncertain ones between them by
 * syllable weight, instead of dropping them to a heuristic guess; (3) snaps each
 * start to a local energy onset via `snap(tAbs)`; (4) ends each word on the best
 * evidence available rather than always holding until the next one.
 *
 * @param {{start:number,end:number,words:Array}} line  mutated in place
 * @param {Array<{start:number,end:number,score?:number}>} spans  aligner output,
 *   relative to `offsetSec`, one entry per word (holes allowed).
 * @param {{ offsetSec?: number, floorSec?: number, nextLineStart?: number|null,
 *           snap?: ((t:number)=>number)|null,
 *           onsetsIn?: ((from:number,to:number)=>number[])|null,
 *           voiceEndIn?: ((from:number,to:number)=>number)|null,
 *           minScore?: number }} [opts]
 *   `onsetsIn`/`voiceEndIn` are stem-only (on a full mix, energy is drums).
 * @returns {boolean} true when at least one confident anchor was applied.
 */
export function applyWordSpans(
  line,
  spans,
  {
    offsetSec = 0,
    floorSec = -Infinity,
    nextLineStart = null,
    snap = null,
    onsetsIn = null,
    voiceEndIn = null,
    minScore = MIN_WORD_SCORE,
  } = {}
) {
  const words = line?.words;
  if (!line || !Array.isArray(spans) || !(words?.length > 0)) return false;

  // 1. Confident CTC anchors, in absolute song time.
  const anchors = [];
  spans.forEach((span, j) => {
    if (!span || !(span.end > span.start)) return;
    if (span.score != null && span.score < minScore) return;
    anchors.push({ i: j, start: offsetSec + span.start, end: offsetSec + span.end, score: span.score ?? 1 });
  });
  if (!anchors.length) return false; // nothing trustworthy — keep existing timing
  const anchorScore = new Map(anchors.map((a) => [a.i, a.score]));
  const anchorEnd = new Map(anchors.map((a) => [a.i, a.end]));

  // 2. Re-anchor the line to the real vocal (bounded by the previous line's end).
  const originalEnd = line.end;
  const originalStart = line.start;
  let lineStart = anchors[0].start;
  // The line's true first word often isn't a confident anchor: soft consonants
  // (h/s/f/th) and swelling held vowels score low, so the first ANCHOR can be
  // word 2 or 3. Anchoring the line there fires the highlight late while the
  // singer is already on word 1 — the "late off the jump" feel. Back-extrapolate
  // to word 0 at this line's own pace, then let the onset snap confirm it: snap
  // only moves onto a real energy rise, so a bad guess degrades to the
  // extrapolated time rather than inventing an onset.
  if (anchors[0].i > 0) {
    const pace = secPerWeight(words, anchors, originalStart, originalEnd);
    let leadWeight = 0;
    for (let k = 0; k < anchors[0].i; k++) leadWeight += wordWeight(words[k]);
    const back = Math.min(leadWeight * pace, MAX_LEAD_EXTRAPOLATION_SEC);
    let est = anchors[0].start - back;
    if (snap) est = snap(est);
    lineStart = est;
  }
  // Cap against the next line so re-anchoring can't create overlapping ranges
  // that make the display jump between two "current" lines.
  const endCap =
    Number.isFinite(nextLineStart) && nextLineStart > floorSec ? nextLineStart - 0.02 : Infinity;
  line.start = clampT(
    lineStart,
    floorSec,
    Math.min(anchors[0].start, originalEnd - 0.1, Number.isFinite(endCap) ? endCap : Infinity)
  );
  // How far we moved the catalog line start — folded into global syncOffset by
  // the caller (median across early lines ≈ constant catalog lead-in).
  line._reanchorDelta = line.start - originalStart;
  line.end = Math.min(Math.max(originalEnd, anchors[anchors.length - 1].end), endCap);
  if (!(line.end > line.start)) line.end = line.start + 0.05;

  // 3. Place starts: anchors from CTC, gaps interpolated by syllable weight.
  const starts = new Array(words.length).fill(null);
  for (const a of anchors) starts[a.i] = clampT(a.start, line.start, line.end);

  const fillRange = (loIdx, hiIdx, tA, tB) => {
    const idxs = [];
    for (let k = loIdx; k < hiIdx; k++) if (starts[k] == null) idxs.push(k);
    if (!idxs.length) return;
    const weights = idxs.map((k) => wordWeight(words[k]));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0, tB - tA);
    let t = tA;
    const guess = [];
    idxs.forEach((k, m) => {
      guess.push(t);
      t += (weights[m] / total) * span;
    });
    // The even spread above assumes constant tempo. When we can see the vocal's
    // real syllable attacks (stem only), prefer those — that's what rubato moves.
    // A held note pushes the following attack late, so the held word simply keeps
    // the time instead of the spread stealing it.
    const placed = onsetsIn ? fitToOnsets(guess, onsetsIn(tA, tB), tA, tB) : guess;
    idxs.forEach((k, m) => {
      starts[k] = placed[m];
    });
  };
  fillRange(0, anchors[0].i, line.start, starts[anchors[0].i]); // before first anchor
  for (let a = 0; a < anchors.length - 1; a++) {
    fillRange(anchors[a].i + 1, anchors[a + 1].i, anchors[a].end, starts[anchors[a + 1].i]);
  }
  const lastA = anchors[anchors.length - 1];
  fillRange(lastA.i + 1, words.length, lastA.end, line.end); // after last anchor

  // 4. Onset-snap + enforce strictly increasing starts within the line. Seed so
  //    the first word may sit exactly at the (re-anchored) line start.
  let prev = line.start - 0.02;
  for (let k = 0; k < words.length; k++) {
    let s = starts[k] == null ? prev + 0.05 : starts[k];
    if (snap) s = snap(s);
    s = clampT(s, prev + 0.02, line.end - 0.02);
    starts[k] = s;
    prev = s;
  }
  // 5. Word ends, from the best evidence available.
  //
  //    Ends used to be purely "wherever the next word starts", with the last word
  //    stretched to line.end. That makes every pause look like a held note and
  //    dumps all of a line's slack onto its final word — the highlight races past
  //    a genuinely elongated word mid-verse, then the last word sits lit forever.
  //
  //    In order of trust: the CTC span's own end (it measures duration, and works
  //    on a full mix); where the voice actually stops (stem only — on a full mix
  //    energy never really drops, so this correctly no-ops); otherwise the old
  //    contiguous behaviour. A gap smaller than GAP_TOLERANCE still stretches to
  //    the next word so normal singing keeps one smooth continuous wipe.
  for (let k = 0; k < words.length; k++) {
    const start = starts[k];
    const nextStart = k + 1 < words.length ? starts[k + 1] : line.end;
    // Voice first: it's a direct measurement of when sound stops, and CTC tends
    // to emit a token early and under-measure a sustained vowel — the exact case
    // where a held note must keep its full length.
    let natural = null;
    if (voiceEndIn) natural = voiceEndIn(start, nextStart);
    else if (anchorEnd.has(k)) natural = Math.min(anchorEnd.get(k), nextStart);
    words[k].start = start;
    words[k].end =
      natural == null || nextStart - natural <= GAP_TOLERANCE_SEC ? nextStart : natural;
    if (words[k].end <= words[k].start) words[k].end = words[k].start + 0.02;
    words[k].score = anchorScore.has(k) ? anchorScore.get(k) : 0;
  }
  // Mostly-interpolated line → per-word timing is a guess; flag for line-level UI.
  line._alignCoverage = anchors.length / words.length;
  line.uncertain = line._alignCoverage < UNCERTAIN_COVERAGE;
  line._vocalAligned = true;
  return true;
}
