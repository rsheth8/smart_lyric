// STFT / iSTFT for vocal separation (MDX-Net) — pure, dependency-free DSP.
//
// MDX-Net models take the complex STFT of the mix (real & imaginary parts as
// channels) and emit the vocal STFT; we iSTFT that back to a waveform. This file
// is the transform core: an arbitrary-N complex FFT (MDX uses n_fft=6144, which
// is NOT a power of two, so radix-2 alone won't do), plus framed STFT/iSTFT with
// a Hann window and constant-overlap-add reconstruction. Everything here is
// deterministic arithmetic so it can be unit-tested without any model.

const PI2 = Math.PI * 2;

/** In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be 2^k. */
export function fftRadix2(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * PI2) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k;
        const b = a + (len >> 1);
        const tr = cr * re[b] - ci * im[b];
        const ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const isPow2 = (n) => (n & (n - 1)) === 0;
const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * Arbitrary-length complex FFT via Bluestein's chirp-z algorithm (uses the
 * radix-2 FFT internally). Operates in place on `re`/`im` of any length N.
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  if (isPow2(n)) {
    fftRadix2(re, im, inverse);
    return;
  }
  const sign = inverse ? 1 : -1;
  const m = nextPow2(2 * n - 1);

  // Chirp w[k] = exp(sign * i * PI * k^2 / n).
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // (k*k mod 2n) keeps the angle accurate for large k.
    const j = (k * k) % (2 * n);
    const ang = (sign * Math.PI * j) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  const are = new Float64Array(m);
  const aim = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    are[k] = re[k] * cosT[k] - im[k] * sinT[k];
    aim[k] = re[k] * sinT[k] + im[k] * cosT[k];
  }

  // b[k] = conj(chirp) at 0 and mirrored; convolution kernel.
  const bre = new Float64Array(m);
  const bim = new Float64Array(m);
  bre[0] = cosT[0];
  bim[0] = -sinT[0];
  for (let k = 1; k < n; k++) {
    const cr = cosT[k];
    const ci = -sinT[k];
    bre[k] = cr;
    bim[k] = ci;
    bre[m - k] = cr;
    bim[m - k] = ci;
  }

  fftRadix2(are, aim, false);
  fftRadix2(bre, bim, false);
  for (let k = 0; k < m; k++) {
    const r = are[k] * bre[k] - aim[k] * bim[k];
    const i2 = are[k] * bim[k] + aim[k] * bre[k];
    are[k] = r;
    aim[k] = i2;
  }
  fftRadix2(are, aim, true); // inverse → linear convolution result

  for (let k = 0; k < n; k++) {
    const cr = cosT[k];
    const ci = sinT[k];
    re[k] = are[k] * cr - aim[k] * ci;
    im[k] = are[k] * ci + aim[k] * cr;
  }
  if (inverse) {
    for (let k = 0; k < n; k++) {
      re[k] /= n;
      im[k] /= n;
    }
  }
}

/** Periodic Hann window of length n (matches librosa/torch default). */
export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((PI2 * i) / n);
  return w;
}

/**
 * Short-time Fourier transform with center padding (reflect), like librosa's
 * default. Returns per-frame full complex spectra (length nFft).
 * @returns {{ re: Float64Array[], im: Float64Array[], frames: number, nFft: number, hop: number }}
 */
export function stft(signal, { nFft = 4096, hop = 1024, window = null } = {}) {
  const win = window || hannWindow(nFft);
  const pad = nFft >> 1;
  // Reflect-pad both ends so frame centers align with sample indices.
  const padded = reflectPad(signal, pad);
  const frames = 1 + Math.floor((padded.length - nFft) / hop);
  const re = [];
  const im = [];
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const fr = new Float64Array(nFft);
    const fi = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) fr[i] = padded[start + i] * win[i];
    fft(fr, fi, false);
    re.push(fr);
    im.push(fi);
  }
  return { re, im, frames, nFft, hop };
}

/**
 * Inverse STFT with constant-overlap-add and window normalization. Inverts
 * `stft` for COLA-satisfying (nFft, hop, Hann) settings. `length` trims the
 * reflect padding back to the original signal length.
 */
export function istft({ re, im, nFft, hop }, { window = null, length = null } = {}) {
  const win = window || hannWindow(nFft);
  const frames = re.length;
  const pad = nFft >> 1;
  const outLen = (frames - 1) * hop + nFft;
  const out = new Float64Array(outLen);
  const norm = new Float64Array(outLen);
  const fr = new Float64Array(nFft);
  const fi = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    fr.set(re[f]);
    fi.set(im[f]);
    fft(fr, fi, true); // inverse FFT → time-domain frame (real part)
    const start = f * hop;
    for (let i = 0; i < nFft; i++) {
      out[start + i] += fr[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  // Remove the center padding.
  const trimmed = out.subarray(pad, outLen - pad);
  if (length == null) return Float64Array.from(trimmed);
  const res = new Float64Array(length);
  res.set(trimmed.subarray(0, Math.min(length, trimmed.length)));
  return res;
}

/** Reflect-pad a 1-D signal by `pad` on each side (edge sample not repeated). */
export function reflectPad(signal, pad) {
  const n = signal.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i++) out[pad + i] = signal[i];
  for (let i = 0; i < pad; i++) {
    const left = Math.min(n - 1, i + 1);
    const right = Math.max(0, n - 2 - i);
    out[pad - 1 - i] = signal[left];
    out[pad + n + i] = signal[right];
  }
  return out;
}
