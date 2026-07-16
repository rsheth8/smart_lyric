// CTC forced alignment — align a KNOWN token sequence to per-frame CTC emissions.
//
// This is the "trellis + backtrack" algorithm from the torchaudio Forced
// Alignment tutorial (CTC-Segmentation), ported to plain JS. It is deliberately
// dependency-free so the DP can be unit-tested without a speech model: the model
// runner (electron/align.cjs) produces `emission` (log-probabilities per frame)
// and the label dictionary; everything here is pure arithmetic.
//
// Shapes:
//   emission : number[numFrame][numLabel]  (log-probs, e.g. log_softmax output)
//   tokens   : number[]                    transcript as label ids, INCLUDING the
//                                          leading/trailing word-separator token
//                                          (mirrors "|I|HAD|…|" in the tutorial)
// Frame indices are converted to seconds by the caller via
//   seconds = frameIndex * (audioDurationSec / numFrame)

const NEG_INF = -Infinity;
const POS_INF = Infinity;

/**
 * Build the trellis (max-score DP over frames × transcript tokens).
 * @returns {Float64Array} flat [numFrame * numTokens], index (t*numTokens + j)
 */
export function buildTrellis(emission, tokens, blankId = 0) {
  const numFrame = emission.length;
  const numTokens = tokens.length;
  const T = new Float64Array(numFrame * numTokens);

  // trellis[1:, 0] = cumsum(emission[1:, blank]); trellis[0, 0] = 0
  let cum = 0;
  for (let t = 1; t < numFrame; t++) {
    cum += emission[t][blankId];
    T[t * numTokens + 0] = cum;
  }
  // trellis[0, 1:] = -inf
  for (let j = 1; j < numTokens; j++) T[0 * numTokens + j] = NEG_INF;
  // trellis[-numTokens+1:, 0] = +inf (force reaching the last token by the end)
  for (let t = Math.max(1, numFrame - numTokens + 1); t < numFrame; t++) {
    T[t * numTokens + 0] = POS_INF;
  }

  for (let t = 0; t < numFrame - 1; t++) {
    const blank = emission[t][blankId];
    for (let j = 1; j < numTokens; j++) {
      const stay = T[t * numTokens + j] + blank; // same token, blank frame
      const change = T[t * numTokens + (j - 1)] + emission[t][tokens[j]]; // next token
      T[(t + 1) * numTokens + j] = Math.max(stay, change);
    }
  }
  return T;
}

/**
 * Backtrack the most likely path through the trellis.
 * @returns {{tokenIndex:number, timeIndex:number, score:number}[]}
 */
export function backtrack(trellis, emission, tokens, blankId = 0) {
  const numFrame = emission.length;
  const numTokens = tokens.length;
  let t = numFrame - 1;
  let j = numTokens - 1;

  const path = [{ tokenIndex: j, timeIndex: t, score: Math.exp(emission[t][blankId]) }];
  while (j > 0) {
    // t should always be > 0 here for a valid alignment.
    const pStay = emission[t - 1][blankId];
    const pChange = emission[t - 1][tokens[j]];
    const stayed = trellis[(t - 1) * numTokens + j] + pStay;
    const changed = trellis[(t - 1) * numTokens + (j - 1)] + pChange;
    t -= 1;
    const didChange = changed > stayed;
    if (didChange) j -= 1;
    path.push({ tokenIndex: j, timeIndex: t, score: Math.exp(didChange ? pChange : pStay) });
    if (t === 0 && j > 0) break; // ran out of frames — malformed, bail gracefully
  }
  // Pad the remaining leading frames on the first token (for completeness).
  while (t > 0) {
    path.push({ tokenIndex: j, timeIndex: t - 1, score: Math.exp(emission[t - 1][blankId]) });
    t -= 1;
  }
  return path.reverse();
}

/**
 * Merge consecutive path points that share a token into per-token segments.
 * @returns {{tokenIndex:number, start:number, end:number, score:number}[]}
 *   start/end are frame indices ([start, end)).
 */
export function mergeRepeats(path) {
  const segments = [];
  let i1 = 0;
  while (i1 < path.length) {
    let i2 = i1;
    while (i2 < path.length && path[i2].tokenIndex === path[i1].tokenIndex) i2 += 1;
    let sum = 0;
    for (let k = i1; k < i2; k++) sum += path[k].score;
    segments.push({
      tokenIndex: path[i1].tokenIndex,
      start: path[i1].timeIndex,
      end: path[i2 - 1].timeIndex + 1,
      score: sum / (i2 - i1),
    });
    i1 = i2;
  }
  return segments;
}

/**
 * Group per-token segments into words, splitting on the separator token.
 * @returns {{start:number, end:number, score:number}[]} one entry per word, in order.
 */
export function mergeWords(segments, tokens, separatorId) {
  const words = [];
  let i1 = 0;
  let i2 = 0;
  const isSep = (seg) => tokens[seg.tokenIndex] === separatorId;
  while (i1 < segments.length) {
    if (i2 >= segments.length || isSep(segments[i2])) {
      if (i1 !== i2) {
        const segs = segments.slice(i1, i2);
        let wsum = 0;
        let wlen = 0;
        for (const s of segs) {
          const len = s.end - s.start;
          wsum += s.score * len;
          wlen += len;
        }
        words.push({
          start: segments[i1].start,
          end: segments[i2 - 1].end,
          score: wlen ? wsum / wlen : 0,
        });
      }
      i1 = i2 + 1;
      i2 = i1;
    } else {
      i2 += 1;
    }
  }
  return words;
}

/**
 * Full pipeline: emissions + transcript tokens → per-word frame spans.
 * `tokens` must be enclosed with the separator on both ends (e.g. [|, A, B, |]).
 * @returns {{start:number, end:number, score:number}[]|null} frame-indexed word
 *   spans (one per word between separators), or null if alignment is impossible.
 */
export function alignTokens(emission, tokens, { blankId = 0, separatorId = 1 } = {}) {
  const numFrame = emission.length;
  if (!numFrame || tokens.length < 1) return null;
  // Need at least as many frames as tokens for a monotonic alignment.
  if (numFrame < tokens.length) return null;
  const trellis = buildTrellis(emission, tokens, blankId);
  const path = backtrack(trellis, emission, tokens, blankId);
  const segments = mergeRepeats(path);
  return mergeWords(segments, tokens, separatorId);
}
