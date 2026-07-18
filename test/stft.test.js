import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, fftRadix2, stft, istft, hannWindow } from '../lib/stft.mjs';

/** Naive O(n^2) DFT for ground truth. */
function naiveDft(re, im, inverse = false) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (sign * 2 * Math.PI * k * t) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      sr += re[t] * c - im[t] * s;
      si += re[t] * s + im[t] * c;
    }
    outRe[k] = inverse ? sr / n : sr;
    outIm[k] = inverse ? si / n : si;
  }
  return { outRe, outIm };
}

const maxErr = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

test('radix-2 FFT matches the naive DFT', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
  const im = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
  const { outRe, outIm } = naiveDft(re, im);
  const fr = Float64Array.from(re);
  const fi = Float64Array.from(im);
  fftRadix2(fr, fi, false);
  assert.ok(maxErr(fr, outRe) < 1e-9, 're within tol');
  assert.ok(maxErr(fi, outIm) < 1e-9, 'im within tol');
});

test('Bluestein FFT matches the naive DFT for non-power-of-2 lengths', () => {
  for (const n of [3, 5, 12, 100, 384]) {
    const re = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
    const im = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
    const { outRe, outIm } = naiveDft(re, im);
    const fr = Float64Array.from(re);
    const fi = Float64Array.from(im);
    fft(fr, fi, false);
    assert.ok(maxErr(fr, outRe) < 1e-7, `re n=${n}`);
    assert.ok(maxErr(fi, outIm) < 1e-7, `im n=${n}`);
  }
});

test('FFT then inverse FFT reconstructs the input (incl. n=6144, MDX)', () => {
  for (const n of [6144, 250]) {
    const re = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
    const im = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
    const fr = Float64Array.from(re);
    const fi = Float64Array.from(im);
    fft(fr, fi, false);
    fft(fr, fi, true);
    assert.ok(maxErr(fr, re) < 1e-7, `re roundtrip n=${n}`);
    assert.ok(maxErr(fi, im) < 1e-7, `im roundtrip n=${n}`);
  }
});

test('STFT → iSTFT reconstructs a signal (COLA)', () => {
  const len = 5000;
  const sig = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    sig[i] = 0.5 * Math.sin(i / 7) + 0.3 * Math.sin(i / 3 + 1) + 0.1 * (Math.random() * 2 - 1);
  }
  const nFft = 512;
  const hop = 128; // nFft/4 → Hann satisfies constant-overlap-add
  const spec = stft(sig, { nFft, hop });
  const recon = istft(spec, { length: len });
  // Ignore the first/last frame edges where COLA isn't fully satisfied.
  let m = 0;
  for (let i = nFft; i < len - nFft; i++) m = Math.max(m, Math.abs(recon[i] - sig[i]));
  assert.ok(m < 1e-6, `reconstruction error ${m}`);
});

test('hannWindow is periodic and bounded', () => {
  const w = hannWindow(8);
  assert.equal(w[0], 0);
  assert.ok(Math.max(...w) <= 1);
  assert.equal(w.length, 8);
});
