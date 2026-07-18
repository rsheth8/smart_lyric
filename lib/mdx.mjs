// MDX-Net spectrogram packing — pure glue between audio and the ONNX model.
//
// An MDX-Net vocal model consumes the complex STFT of a stereo chunk laid out as
// a [1, 4, dimF, dimT] tensor — 4 = 2 channels × (real, imag) — and emits the
// vocal STFT in the same layout, which we invert back to audio. These functions
// are the deterministic pack/unpack around the model (separate.cjs supplies the
// ONNX session and chunk loop). Kept pure so the layout + iSTFT are unit-testable
// with an identity "model": netToMix(mixToNet(x)) ≈ x.

import { stft, istft, hannWindow } from './stft.mjs';

/** Samples per model chunk that yield exactly `dimT` STFT frames (center-padded). */
export function mdxChunkSamples({ hop, dimT }) {
  return (dimT - 1) * hop;
}

/** Index into a flat [1, 4, dimF, dimT] tensor. */
const idx = (ch, part, f, t, dimF, dimT) => (((ch * 2 + part) * dimF + f) * dimT + t);

/**
 * Stereo chunk → flat Float32 [1, 4, dimF, dimT] (model input).
 * @param {[Float64Array, Float64Array]} stereo  two channels, length mdxChunkSamples
 */
export function mixToNet(stereo, { nFft, hop, dimF, dimT, window = null }) {
  const win = window || hannWindow(nFft);
  const out = new Float32Array(4 * dimF * dimT);
  for (let c = 0; c < 2; c++) {
    const { re, im } = stft(stereo[c], { nFft, hop, window: win });
    for (let t = 0; t < dimT; t++) {
      const fr = re[t];
      const fi = im[t];
      if (!fr) continue;
      for (let f = 0; f < dimF; f++) {
        out[idx(c, 0, f, t, dimF, dimT)] = fr[f];
        out[idx(c, 1, f, t, dimF, dimT)] = fi[f];
      }
    }
  }
  return out;
}

/**
 * Model output [1, 4, dimF, dimT] → stereo waveform. Frequencies above `dimF`
 * are zero (the model doesn't predict them); Hermitian symmetry is restored so
 * the inverse transform is real.
 * @returns {[Float64Array, Float64Array]}
 */
export function netToMix(tensor, { nFft, hop, dimF, dimT, window = null, length = null }) {
  const win = window || hannWindow(nFft);
  const chans = [];
  const half = nFft >> 1;
  for (let c = 0; c < 2; c++) {
    const re = [];
    const im = [];
    for (let t = 0; t < dimT; t++) {
      const fr = new Float64Array(nFft);
      const fi = new Float64Array(nFft);
      for (let f = 0; f < dimF; f++) {
        fr[f] = tensor[idx(c, 0, f, t, dimF, dimT)];
        fi[f] = tensor[idx(c, 1, f, t, dimF, dimT)];
      }
      // Mirror positive freqs into negative freqs: X[N-f] = conj(X[f]).
      for (let f = 1; f < half; f++) {
        fr[nFft - f] = fr[f];
        fi[nFft - f] = -fi[f];
      }
      re.push(fr);
      im.push(fi);
    }
    chans.push(istft({ re, im, nFft, hop }, { window: win, length }));
  }
  return chans;
}
