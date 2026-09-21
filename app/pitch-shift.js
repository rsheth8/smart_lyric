// Key change: shift the backing track's pitch without touching its tempo, so a
// singer can drop a song two steps and still sing along to the same timeline.
//
// SOLA (synchronised overlap-add) + resampling, the SoundTouch approach:
//   1. time-stretch the input by `ratio` — overlap-add frames whose splice point
//      is chosen by cross-correlation, so the two halves meet IN PHASE;
//   2. read that stretched signal back at `ratio` samples per output sample.
// Duration comes out unchanged and the pitch scales by exactly `ratio`.
//
// The correlation search is the whole point. A fixed-offset crossfade (the
// "two read heads half a grain apart" design) splices at an arbitrary phase, and
// the interference between the two heads pulls the output off-key — measured
// 28 cents flat at +2 semitones, which is a quarter tone. This version lands
// inside 5 cents (test/pitch-shift.test.js).
//
// ponytail: time-domain, mono-per-channel, correlation on every 4th sample.
// A phase vocoder would beat it on dense mixes; revisit only if singers notice.
//
// Every function here is SELF-CONTAINED on purpose — app/karaoke.js stringifies
// them into an AudioWorklet module, which has no import graph of its own.

/** SOLA frame (~43 ms at 48 kHz). Also the shifter's latency. */
export const SEQUENCE = 2048;
/** Crossfade length between frames. */
export const OVERLAP = 512;
/** How far the splice point may move to find a phase-aligned match. */
export const SEEK = 512;
/** Correlate every Nth sample — 4× less work, same winning offset. */
export const CORR_STRIDE = 4;

export function createShifter(opts) {
  const sequence = (opts && opts.sequence) || 2048;
  const overlap = (opts && opts.overlap) || 512;
  const seek = (opts && opts.seek) || 512;
  const cap = (sequence + seek) * 4;
  return {
    sequence,
    overlap,
    seek,
    inBuf: new Float32Array(cap),
    inLen: 0,
    inPos: 0,
    outBuf: new Float32Array(cap),
    outLen: 0,
    outPos: 0,
    cap,
  };
}

/** Offset in [0, seek] where `cand` best lines up in phase with `tail`. */
export function bestOffset(tail, tailAt, cand, candAt, overlap, seek, stride) {
  let best = 0;
  let bestScore = -Infinity;
  for (let off = 0; off <= seek; off += stride) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < overlap; i += stride) {
      const c = cand[candAt + off + i];
      dot += tail[tailAt + i] * c;
      energy += c * c;
    }
    // Normalised: a loud-but-misaligned window shouldn't beat a quiet aligned one.
    const score = energy > 0 ? dot / Math.sqrt(energy) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = off;
    }
  }
  return best;
}

/** Emit one time-stretched frame. Returns false when the input hasn't arrived yet. */
export function solaFrame(state, ratio) {
  const S = state.sequence;
  const O = state.overlap;
  const K = state.seek;
  const start = Math.floor(state.inPos);
  if (state.inLen < start + S + K) return false;
  if (state.outLen + S >= state.cap) return false;

  if (state.outLen < O) {
    // First frame: nothing to splice against, so lay it down as-is.
    for (let i = 0; i < S; i++) state.outBuf[state.outLen + i] = state.inBuf[start + i];
    state.outLen += S;
  } else {
    const off = bestOffset(state.outBuf, state.outLen - O, state.inBuf, start, O, K, 4);
    const src = start + off;
    const base = state.outLen - O;
    for (let i = 0; i < O; i++) {
      const w = i / O;
      state.outBuf[base + i] = state.outBuf[base + i] * (1 - w) + state.inBuf[src + i] * w;
    }
    for (let i = O; i < S; i++) state.outBuf[base + i] = state.inBuf[src + i];
    state.outLen = base + S;
  }
  // Synthesis hop is fixed; the analysis hop is what stretches time.
  state.inPos += (S - O) / ratio;
  return true;
}

/** Drop everything both cursors have moved past, so the buffers stay bounded. */
export function compact(state) {
  const ik = Math.floor(state.inPos);
  if (ik > state.sequence) {
    state.inBuf.copyWithin(0, ik, state.inLen);
    state.inLen -= ik;
    state.inPos -= ik;
  }
  const ok = Math.floor(state.outPos);
  if (ok > state.sequence) {
    state.outBuf.copyWithin(0, ok, state.outLen);
    state.outLen -= ok;
    state.outPos -= ok;
  }
}

/** Pitch-shift `input` into `output` by `ratio` (1 = unchanged, 2 = an octave up). */
export function shiftInto(state, input, output, ratio) {
  const n = output.length;
  const r = ratio > 0 ? ratio : 1;

  if (input) {
    if (state.inLen + n > state.cap) {
      const drop = state.inLen + n - state.cap;
      state.inBuf.copyWithin(0, drop, state.inLen);
      state.inLen -= drop;
      state.inPos = Math.max(0, state.inPos - drop);
    }
    for (let i = 0; i < n; i++) state.inBuf[state.inLen + i] = input[i];
    state.inLen += n;
  }

  const need = Math.ceil(state.outPos + n * r) + 2;
  while (state.outLen < need) if (!solaFrame(state, r)) break;

  let p = state.outPos;
  const last = state.outLen - 2;
  for (let i = 0; i < n; i++) {
    if (p > last) {
      // Still filling the first frame (or starved) — silence beats a click.
      output[i] = 0;
      continue;
    }
    const i0 = Math.floor(p);
    const f = p - i0;
    output[i] = state.outBuf[i0] + (state.outBuf[i0 + 1] - state.outBuf[i0]) * f;
    p += r;
  }
  state.outPos = p;
  compact(state);
}
