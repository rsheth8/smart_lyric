// Standalone forced-alignment diagnostic — no Electron, no UI.
//
// Runs the real CTC aligner (electron/align.cjs `alignSong`) over a WAV + its LRC
// and reports how confident the alignment is: per-word CTC score distribution, how
// many words aligned at all, and — the number that matters for the display — what
// fraction of lines would fall back to line-level rendering (coverage below the
// `UNCERTAIN_COVERAGE` threshold the display uses).
//
// Its purpose is to SIZE the "separate the vocal before aligning on the live mic
// path" question: run `--both` to align the raw mix and the isolated vocal stem and
// print them side by side. If the raw mix is already mostly confident, wiring
// separation into the live loop buys little; if the stem is much better, it's worth
// the cost.
//
// Usage:
//   node --env-file=.env scripts/align-check.mjs <input.wav> <lyrics.lrc> [--stem|--both]
//
//   (default)  align the raw mix           (minScore 0.30, like the mic path)
//   --stem     separate first, align stem  (minScore 0.15, like the local-file path)
//   --both     do both and compare
//
// Convert audio to WAV first:  ffmpeg -i song.mp3 -ac 2 -ar 44100 song.wav

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { decodeWAV, rms } from '../app/wav.js';
import { alignSong, alignAvailable } from '../electron/align.cjs';
import { separateVocals, separateStatus, separateShutdown } from '../electron/separate.cjs';

// Mirror the constants the renderer/display use (app/align.js).
const TARGET_RATE = 16000;
const ALIGN_SEARCH_PAD_SEC = 0.6;
const UNCERTAIN_COVERAGE = 0.6;
const MIN_WORD_SCORE_MIX = 0.3; // raw-mix gate (refineTimelineFromMic / non-stem)
const MIN_WORD_SCORE_STEM = 0.15; // clean-stem gate (refineTimelineWithAudio, fromStem)

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [inArg, lrcArg] = args.filter((a) => !a.startsWith('--'));
if (!inArg || !lrcArg) {
  console.error('usage: node --env-file=.env scripts/align-check.mjs <input.wav> <lyrics.lrc> [--stem|--both]');
  process.exit(1);
}
if (!alignAvailable()) {
  console.error('✗ @huggingface/transformers not installed — the aligner cannot run.');
  process.exit(1);
}

const inputPath = resolve(inArg);
const lrcPath = resolve(lrcArg);

// --- Minimal LRC parse: line start/end + whitespace-split word texts. --------
// The aligner only needs {start,end,words:[string]}; we deliberately avoid the
// provider's syllable spread so we measure the acoustic alignment, not the guess.
function parseLrc(text) {
  const rows = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]);
    const words = m[3].trim().split(/\s+/).filter(Boolean);
    if (words.length) rows.push({ start: t, words });
  }
  rows.sort((a, b) => a.start - b.start);
  return rows.map((r, i) => ({
    start: r.start,
    end: i + 1 < rows.length ? rows[i + 1].start : r.start + 4,
    words: r.words,
  }));
}

// --- Simple linear resample to 16 kHz mono. ---------------------------------
function toMono16k(channels, sampleRate) {
  const chs = channels.length;
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < chs; c++) s += channels[c][i];
    mono[i] = s / chs;
  }
  if (sampleRate === TARGET_RATE) return mono;
  const ratio = TARGET_RATE / sampleRate;
  const outLen = Math.round(n * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = mono[i0] || 0;
    const b = mono[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// --- Score/coverage aggregation over an alignSong result. --------------------
function summarize(result, lines, minScore) {
  const buckets = { '0.0-0.15': 0, '0.15-0.3': 0, '0.3-0.5': 0, '0.5-0.7': 0, '0.7-1.0': 0 };
  let totalWords = 0;
  let alignedWords = 0; // non-null span
  let anchorWords = 0; // span && score >= minScore
  let uncertainLines = 0;
  const outLines = result?.lines || [];
  lines.forEach((line, li) => {
    const words = line.words;
    const spans = outLines[li]?.words || [];
    let anchors = 0;
    words.forEach((_, wi) => {
      totalWords++;
      const sp = spans[wi];
      if (!sp) return;
      alignedWords++;
      const sc = sp.score ?? 0;
      if (sc >= minScore) {
        anchorWords++;
        anchors++;
      }
      if (sc < 0.15) buckets['0.0-0.15']++;
      else if (sc < 0.3) buckets['0.15-0.3']++;
      else if (sc < 0.5) buckets['0.3-0.5']++;
      else if (sc < 0.7) buckets['0.5-0.7']++;
      else buckets['0.7-1.0']++;
    });
    const coverage = words.length ? anchors / words.length : 0;
    if (coverage < UNCERTAIN_COVERAGE) uncertainLines++;
  });
  return {
    totalWords,
    alignedWords,
    anchorWords,
    uncertainLines,
    totalLines: lines.length,
    buckets,
    linesAligned: result?.aligned ?? 0,
  };
}

function report(label, s) {
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '0');
  console.log(`\n── ${label} ───────────────────────────────`);
  console.log(`  lines aligned:      ${s.linesAligned}/${s.totalLines}`);
  console.log(`  words with a span:  ${s.alignedWords}/${s.totalWords}  (${pct(s.alignedWords, s.totalWords)}%)`);
  console.log(`  confident anchors:  ${s.anchorWords}/${s.totalWords}  (${pct(s.anchorWords, s.totalWords)}%)`);
  console.log(`  LINE-LEVEL fallback:${s.uncertainLines}/${s.totalLines} lines  (${pct(s.uncertainLines, s.totalLines)}%)  ← lower is better`);
  console.log('  CTC score distribution:');
  for (const [k, v] of Object.entries(s.buckets)) {
    const bar = '█'.repeat(Math.round((40 * v) / Math.max(1, s.alignedWords)));
    console.log(`    ${k.padEnd(9)} ${String(v).padStart(4)}  ${bar}`);
  }
}

// --- Run. --------------------------------------------------------------------
const wav = decodeWAV(readFileSync(inputPath).buffer);
const lines = parseLrc(readFileSync(lrcPath, 'utf8'));
if (!lines.length) {
  console.error('✗ No timestamped lines parsed from the LRC.');
  process.exit(1);
}
const durSec = wav.channels[0].length / wav.sampleRate;
console.log(`Input:  ${basename(inputPath)}  ${wav.numChannels}ch @ ${wav.sampleRate}Hz  ${durSec.toFixed(1)}s`);
console.log(`Lyrics: ${basename(lrcPath)}  ${lines.length} lines, ${lines.reduce((n, l) => n + l.words.length, 0)} words`);

const wantStem = flags.has('--stem') || flags.has('--both');
const wantMix = flags.has('--both') || !flags.has('--stem');

if (wantMix) {
  const pcm = toMono16k(wav.channels, wav.sampleRate);
  console.log(`\nAligning raw mix (rms=${rms(pcm).toFixed(4)})… first run loads the ~90MB model.`);
  const t0 = Date.now();
  const res = await alignSong({ pcm, sampleRate: TARGET_RATE, searchPad: ALIGN_SEARCH_PAD_SEC, lines });
  if (res?.error) console.error(`  aligner error: ${res.error}`);
  report(`RAW MIX  (minScore ${MIN_WORD_SCORE_MIX})  ${((Date.now() - t0) / 1000).toFixed(1)}s`, summarize(res, lines, MIN_WORD_SCORE_MIX));
}

if (wantStem) {
  const st = separateStatus();
  if (!st.available) {
    console.error('\n✗ --stem/--both needs a separation model. Set SEPARATE_MODEL_PATH in .env.');
    process.exit(1);
  }
  console.log('\nSeparating vocal stem… (~1× realtime)');
  const stem = await separateVocals(
    { left: wav.channels[0], right: wav.channels[1] || wav.channels[0], sampleRate: wav.sampleRate },
    { throwOnError: true }
  );
  const pcm = toMono16k([stem.left, stem.right || stem.left], stem.sampleRate);
  console.log(`Aligning stem (rms=${rms(pcm).toFixed(4)})…`);
  const t0 = Date.now();
  const res = await alignSong({ pcm, sampleRate: TARGET_RATE, searchPad: ALIGN_SEARCH_PAD_SEC, lines });
  if (res?.error) console.error(`  aligner error: ${res.error}`);
  report(`VOCAL STEM  (minScore ${MIN_WORD_SCORE_STEM})  ${((Date.now() - t0) / 1000).toFixed(1)}s`, summarize(res, lines, MIN_WORD_SCORE_STEM));
}

// The separation worker is a fork; it holds this process's event loop open.
separateShutdown();

console.log('\nHigher "confident anchors" and lower "LINE-LEVEL fallback" = better word-by-word sync.');
if (flags.has('--both')) {
  console.log('If STEM is much better than RAW MIX, wiring separation into the live mic path is worth the cost (Phase 3a).');
  console.log('If they are close, the live loop can stay on the raw mix and lean on confidence-degradation (Phase 3b).');
}
