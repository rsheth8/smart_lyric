// Cheap mix-density features, computed from the RAW MIX only.
//
// Vocal separation costs ~1.2x realtime and, measured across the test songs, is
// decisive on dense mixes and a no-op on sparse ones. To skip it safely we need
// a predictor of "will CTC struggle on this mix?" that is cheap enough to run
// before deciding — i.e. from the mix alone, in seconds, with no model.
//
// This script computes candidate predictors so they can be correlated against
// the measured raw-mix LINE-LEVEL fallback % from scripts/align-check.mjs.
// It deliberately does NOT decide anything: it produces the evidence for
// whether an adaptive rule is justified at all.
//
// Usage:
//   node scripts/mix-features.mjs <input.wav> [more.wav ...]
//   node scripts/mix-features.mjs --tsv *.wav      (machine-readable)

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeWAV, rms } from '../app/wav.js';
import { fft, hannWindow } from '../lib/stft.mjs';

const N_FFT = 2048;
const HOP = 1024;
// Analysing every frame of a 5-minute song is needless; one frame per ~46ms
// over a decimated signal is plenty for a distribution statistic.
const ANALYSIS_RATE = 22050;

const args = process.argv.slice(2);
const tsv = args.includes('--tsv');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node scripts/mix-features.mjs [--tsv] <input.wav> [more.wav ...]');
  process.exit(1);
}

/** Nearest-neighbour decimation — we want spectral statistics, not fidelity. */
function decimate(samples, from, to) {
  if (from <= to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
}

function magnitudes(frame, win) {
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) re[i] = frame[i] * win[i];
  fft(re, im);
  const half = N_FFT >> 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

function analyze(path) {
  const wav = decodeWAV(readFileSync(path).buffer);
  const L = wav.channels[0];
  const R = wav.channels[1] || L;

  // Mid/side before decimation — stereo width is a production-density cue and
  // a centred vocal sits almost entirely in mid.
  let midE = 0;
  let sideE = 0;
  for (let i = 0; i < L.length; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = 0.5 * (L[i] - R[i]);
    midE += m * m;
    sideE += s * s;
  }
  const sideRatio = sideE / (midE + sideE + 1e-12);

  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const sig = decimate(mono, wav.sampleRate, ANALYSIS_RATE);
  const nyquist = ANALYSIS_RATE / 2;
  const binHz = nyquist / (N_FFT >> 1);

  const win = hannWindow(N_FFT);
  const half = N_FFT >> 1;
  const loBin = Math.floor(250 / binHz);
  const hiBin = Math.floor(4000 / binHz);

  let frames = 0;
  let flatnessSum = 0;
  let centroidSum = 0;
  let lowSum = 0;
  let highSum = 0;
  let fluxSum = 0;
  let prev = null;
  let peak = 0;
  for (let i = 0; i < sig.length; i++) {
    const a = Math.abs(sig[i]);
    if (a > peak) peak = a;
  }

  for (let start = 0; start + N_FFT <= sig.length; start += HOP) {
    const mag = magnitudes(sig.subarray(start, start + N_FFT), win);
    let sum = 0;
    let logSum = 0;
    let weighted = 0;
    let low = 0;
    let high = 0;
    for (let k = 1; k < half; k++) {
      const m = mag[k];
      sum += m;
      logSum += Math.log(m + 1e-12);
      weighted += m * k * binHz;
      if (k < loBin) low += m;
      else if (k > hiBin) high += m;
    }
    if (sum < 1e-9) continue; // silence contributes nothing but noise to the stats
    // Spectral flatness: geometric/arithmetic mean. Tone-like -> 0, noise-like -> 1.
    flatnessSum += Math.exp(logSum / (half - 1)) / (sum / (half - 1));
    centroidSum += weighted / sum;
    lowSum += low / sum;
    highSum += high / sum;
    if (prev) {
      // Spectral flux: rectified frame-to-frame change = onset/percussive density.
      let flux = 0;
      for (let k = 1; k < half; k++) {
        const d = mag[k] - prev[k];
        if (d > 0) flux += d;
      }
      fluxSum += flux / sum;
    }
    prev = mag;
    frames++;
  }

  const n = Math.max(1, frames);
  const r = rms(sig);
  return {
    name: basename(path).replace(/\.wav$/i, ''),
    durSec: L.length / wav.sampleRate,
    rms: r,
    crest: peak / (r + 1e-12),
    flatness: flatnessSum / n,
    centroidHz: centroidSum / n,
    lowRatio: lowSum / n,
    highRatio: highSum / n,
    flux: fluxSum / Math.max(1, n - 1),
    sideRatio,
  };
}

const rows = files.map(analyze);

if (tsv) {
  const cols = ['name', 'durSec', 'rms', 'crest', 'flatness', 'centroidHz', 'lowRatio', 'highRatio', 'flux', 'sideRatio'];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => (typeof r[c] === 'number' ? r[c].toFixed(4) : r[c])).join('\t'));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n = 7) => v.toFixed(4).padStart(n);
  console.log(
    pad('song', 34) + ['rms', 'crest', 'flat', 'centrHz', 'low<250', 'high>4k', 'flux', 'side'].map((h) => h.padStart(8)).join('')
  );
  console.log('-'.repeat(34 + 8 * 8));
  for (const r of rows) {
    console.log(
      pad(r.name.slice(0, 33), 34) +
        num(r.rms) + ' ' +
        num(r.crest) + ' ' +
        num(r.flatness) + ' ' +
        String(Math.round(r.centroidHz)).padStart(7) + ' ' +
        num(r.lowRatio) + ' ' +
        num(r.highRatio) + ' ' +
        num(r.flux) + ' ' +
        num(r.sideRatio)
    );
  }
  console.log('\nHigher flux / flatness / side = denser, busier mix (expected to hurt CTC on the raw mix).');
}
