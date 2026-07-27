// Ground-truth word-timing accuracy — how many milliseconds off are we, really?
//
// `align-check.mjs` reports the aligner's CONFIDENCE. Confidence is a proxy: a
// word can score 0.9 and still be placed 400 ms late. This script measures
// actual error against real word-level timings (NetEase `yrc` or any word-timed
// format we can parse), which is the number the display's sync quality depends
// on and the one the 394 ms baseline in docs/ was quoted from.
//
// Compares three conditions on the same audio:
//   baseline  syllable-weighted estimate from line-level LRC (no audio at all)
//   raw mix   CTC forced alignment on the full mix
//   stem      CTC forced alignment on the isolated vocal
//
// GLOBAL OFFSET IS REMOVED before scoring. Ground truth almost always comes
// from a different upload of the same recording, with a different lead-in — a
// constant shift is not a timing error, and it is exactly what the app's
// syncOffset / auto-timing already corrects for. What matters is the SHAPE:
// residual error after the best constant shift. The script prints the offset it
// removed and the drift slope, so a genuinely different master is visible
// rather than silently scored as noise.
//
// Usage:
//   node --env-file=.env scripts/truth-check.mjs <audio.wav> <lyrics.lrc> <truth.yrc>

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeWAV } from '../app/wav.js';
import { parseLRC } from '../app/providers/formats/lrc.js';
import { parseYRC } from '../app/providers/formats/yrc.js';
import { lcsPairs } from '../app/timeline-cache.js';
import { alignSong, alignAvailable } from '../electron/align.cjs';
import { separateVocals, separateAvailable, separateShutdown } from '../electron/separate.cjs';

const TARGET_RATE = 16000;
const ALIGN_SEARCH_PAD_SEC = 0.6;
// Drift beyond this means the truth is a different master and per-word scoring
// would be measuring the edit, not the aligner.
const MAX_DRIFT_SLOPE = 0.005; // seconds of offset per second of song

const [audioArg, lrcArg, truthArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!audioArg || !lrcArg || !truthArg) {
  console.error('usage: node --env-file=.env scripts/truth-check.mjs <audio.wav> <lyrics.lrc> <truth.yrc>');
  process.exit(1);
}
if (!alignAvailable()) {
  console.error('✗ @huggingface/transformers not installed — the aligner cannot run.');
  process.exit(1);
}

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

function toMono16k(channels, sampleRate) {
  const [L, R = L] = channels;
  const ratio = sampleRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(L.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const j = Math.floor(i * ratio);
    out[i] = 0.5 * (L[j] + (R[j] ?? L[j]));
  }
  return out;
}

const wav = decodeWAV(readFileSync(audioArg).buffer);
const timeline = parseLRC(readFileSync(lrcArg, 'utf8'));
const truth = parseYRC(readFileSync(truthArg, 'utf8'));

const ourWords = timeline.lines.flatMap((l, li) =>
  l.words.map((w, wi) => ({ li, wi, text: w.text, key: norm(w.text), est: w.start }))
).filter((w) => w.key);
const truthWords = truth.lines.flatMap((l) => l.words.map((w) => ({ key: norm(w.text), start: w.start })))
  .filter((w) => w.key);

console.log(`Audio:  ${basename(audioArg)}  ${(wav.channels[0].length / wav.sampleRate).toFixed(1)}s`);
console.log(`Lyrics: ${ourWords.length} words   Truth: ${truthWords.length} words (${basename(truthArg)})`);

const pairs = lcsPairs(ourWords.map((w) => w.key), truthWords.map((w) => w.key));
console.log(`Matched ${pairs.length} words (${((100 * pairs.length) / ourWords.length).toFixed(0)}% of ours)\n`);
if (pairs.length < 30) {
  console.error('✗ too few matched words — is this the same song?');
  separateShutdown();
  process.exit(1);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

/** Score one set of predicted word starts against the matched ground truth. */
function score(label, startsByIndex) {
  const deltas = [];
  const xs = [];
  for (const [oi, ti] of pairs) {
    const pred = startsByIndex[oi];
    if (!Number.isFinite(pred)) continue;
    deltas.push(truthWords[ti].start - pred);
    xs.push(truthWords[ti].start);
  }
  if (!deltas.length) return null;

  // Robust constant offset (see header) + drift check.
  const offset = median(deltas);
  const n = deltas.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = deltas.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (deltas[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den > 0 ? num / den : 0;

  const abs = deltas.map((d) => Math.abs(d - offset));
  const within = (ms) => (100 * abs.filter((a) => a <= ms / 1000).length) / abs.length;
  return {
    label,
    n,
    offset,
    slope,
    median: median(abs),
    p90: quantile(abs, 0.9),
    within100: within(100),
    within200: within(200),
    within300: within(300),
  };
}

function report(r) {
  if (!r) return console.log(`${r?.label ?? '?'}: no data`);
  console.log(`── ${r.label} ${'─'.repeat(Math.max(0, 48 - r.label.length))}`);
  console.log(`  global offset removed: ${(r.offset * 1000).toFixed(0)} ms   drift ${r.slope.toFixed(5)} s/s`);
  if (Math.abs(r.slope) > MAX_DRIFT_SLOPE) {
    console.log('  ⚠️  drift is high — truth may be a different master; treat numbers with suspicion');
  }
  console.log(`  median |error|: ${(r.median * 1000).toFixed(0)} ms`);
  console.log(`  p90    |error|: ${(r.p90 * 1000).toFixed(0)} ms`);
  console.log(
    `  within 100ms: ${r.within100.toFixed(0)}%   200ms: ${r.within200.toFixed(0)}%   300ms: ${r.within300.toFixed(0)}%`
  );
  console.log('');
}

/** alignSong output → predicted start per our-word index (CTC span, else estimate). */
function startsFromAlign(result) {
  const out = new Array(ourWords.length).fill(NaN);
  const lines = result?.lines || [];
  ourWords.forEach((w, idx) => {
    const sp = lines[w.li]?.words?.[w.wi];
    out[idx] = sp && Number.isFinite(sp.start) ? sp.start : w.est;
  });
  return out;
}

const alignPayload = timeline.lines.map((l) => ({
  start: l.start,
  end: l.end,
  words: l.words.map((w) => w.text),
}));

// 1. Baseline: no audio at all, just the syllable-weighted spread from the LRC.
report(score('BASELINE  (line-level LRC, words estimated)', ourWords.map((w) => w.est)));

// 2. Raw mix.
const rawPcm = toMono16k(wav.channels, wav.sampleRate);
process.stdout.write('Aligning raw mix…\n');
const rawRes = await alignSong({ pcm: rawPcm, sampleRate: TARGET_RATE, searchPad: ALIGN_SEARCH_PAD_SEC, lines: alignPayload });
if (rawRes?.error) console.error(`  aligner error: ${rawRes.error}`);
report(score('RAW MIX   (CTC on the full mix)', startsFromAlign(rawRes)));

// 3. Isolated vocal stem.
if (separateAvailable()) {
  process.stdout.write('Separating vocal stem… (~1.2x realtime)\n');
  const stem = await separateVocals(
    { left: wav.channels[0], right: wav.channels[1] || wav.channels[0], sampleRate: wav.sampleRate },
    { throwOnError: true }
  );
  const stemPcm = toMono16k([stem.left, stem.right || stem.left], stem.sampleRate);
  process.stdout.write('Aligning stem…\n');
  const stemRes = await alignSong({ pcm: stemPcm, sampleRate: TARGET_RATE, searchPad: ALIGN_SEARCH_PAD_SEC, lines: alignPayload });
  if (stemRes?.error) console.error(`  aligner error: ${stemRes.error}`);
  report(score('VOCAL STEM (CTC on the isolated vocal)', startsFromAlign(stemRes)));
} else {
  console.log('(separation unavailable — set SEPARATE_MODEL_PATH to compare the stem)\n');
}

// The separation worker is a fork; it holds this process's event loop open.
separateShutdown();

console.log('Error is per-word |start - truth| AFTER removing a constant offset.');
console.log('A constant offset is not a sync error — syncOffset/auto-timing corrects it.');
