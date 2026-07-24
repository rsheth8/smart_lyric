// Offline replay of the LIVE sync loop — answers "does it actually lock, and
// does it land on the right answer?" with numbers instead of by ear.
//
// The live path (app.js `liveAlignTick` → align.js `refineTimelineFromMic`)
// only ever runs against a real mic, so its behaviour has been untestable: you
// play a song, squint at the sync chip, and guess. This harness replays a WAV
// through exactly that loop in Node, with ONE crucial addition — it injects a
// KNOWN output latency, so there is a ground truth to score against.
//
// How the latency injection works: real capture is delayed, so the newest
// sample in the ring buffer is older than the playhead. We reproduce that by
// handing the loop a window that truly covers
//   [songNow − latency − buffer, songNow − latency]
// while `refineTimelineFromMic` labels it as ending at `songNow` (it has no
// other choice — measuring that very gap is the estimator's whole job). The
// estimator should therefore converge to −latency. Anything else is the bug.
//
// Usage:
//   node --env-file=.env scripts/live-sync-check.mjs <input.wav> <lyrics.lrc> [opts]
//
//   --stem <wav>      probe timing on this pre-separated vocal stem instead of
//                     the raw mix. Answers "is the timing scatter caused by the
//                     probes hearing instruments?" without needing live
//                     separation to run at realtime. The stem must be the SAME
//                     recording (sample-aligned) as <input.wav>.
//   --ctc             wire the REAL CTC aligner (electron/align.cjs) into the
//                     bridge shim and mirror app.js's timingOnly gating exactly.
//                     Without this the replay is onset-probe-only, which is what
//                     the app genuinely does PRE-LOCK (refineTimelineFromMic
//                     returns early on any onset sample before reaching CTC), but
//                     it understates post-lock behaviour. Slow: runs the acoustic
//                     model on every tick, so pair it with --to.
//   --latency <sec>   simulated output latency to recover   (default 0.25)
//   --buffer <sec>    mic ring-buffer size                  (default 16, app.js:650)
//   --tick <ms>       loop cadence                          (default 700, scheduleLiveAlign)
//   --from <sec>      start replaying at this song position (default 0)
//   --to <sec>        stop here                             (default: end of audio)
//   --trace           print every tick, not just the summary
//
// Convert audio first:  ffmpeg -i song.mp3 -ac 2 -ar 44100 song.wav

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { decodeWAV } from '../app/wav.js';
import { SyncEstimator, syncLockState, median } from '../app/sync-learn.js';
import { wordsAcrossSpan } from '../app/providers/formats/estimate.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : def;
};
const has = (name) => args.includes(`--${name}`);
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [inArg, lrcArg] = positional;

if (!inArg || !lrcArg) {
  console.error('usage: node --env-file=.env scripts/live-sync-check.mjs <input.wav> <lyrics.lrc> [--latency 0.25] [--trace]');
  process.exit(1);
}

const stemIdx = args.indexOf('--stem');
const STEM_PATH = stemIdx >= 0 ? args[stemIdx + 1] : null;
const LATENCY = flag('latency', 0.25);
const BUFFER_SEC = flag('buffer', 16);
const TICK_MS = flag('tick', 700);
const TRACE = has('trace');

// --- Minimal LRC parse (same shape as scripts/align-check.mjs). --------------
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
  return rows.map((r, i) => {
    const start = r.start;
    const end = i + 1 < rows.length ? rows[i + 1].start : r.start + 4;
    // Build word timings through the REAL estimator the app uses, so we're
    // replaying the same starting timeline the live loop would see.
    return { start, end, words: wordsAcrossSpan(r.words, start, end) };
  });
}

function toMono(channels) {
  const chs = channels.length;
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < chs; c++) s += channels[c][i];
    mono[i] = s / chs;
  }
  return mono;
}

// --- Load. -------------------------------------------------------------------
const wav = decodeWAV(readFileSync(resolve(inArg)).buffer);
const SR = wav.sampleRate;
const pcm = toMono(wav.channels);
const durSec = pcm.length / SR;
// What the simulated capture actually hears. Timing probes run on this; the
// injected latency and window maths are identical either way, so a raw-vs-stem
// run isolates exactly one variable: whether the probes are hearing the voice.
let probePcm = pcm;
if (STEM_PATH) {
  const stemWav = decodeWAV(readFileSync(resolve(STEM_PATH)).buffer);
  if (stemWav.sampleRate !== SR) {
    console.error(`✗ stem is ${stemWav.sampleRate}Hz but the mix is ${SR}Hz — resample it first.`);
    process.exit(1);
  }
  probePcm = toMono(stemWav.channels);
  const drift = Math.abs(probePcm.length - pcm.length) / SR;
  if (drift > 0.5) {
    console.error(`✗ stem is ${drift.toFixed(1)}s different in length — not the same recording.`);
    process.exit(1);
  }
}

const lines = parseLrc(readFileSync(resolve(lrcArg), 'utf8'));
if (!lines.length) {
  console.error('✗ No timestamped lines parsed from the LRC.');
  process.exit(1);
}

const FROM = flag('from', 0);
const TO = Math.min(flag('to', durSec), durSec);

console.log(`Input:   ${basename(inArg)}  ${wav.numChannels}ch @ ${SR}Hz  ${durSec.toFixed(1)}s`);
console.log(`Lyrics:  ${basename(lrcArg)}  ${lines.length} lines`);
console.log(`Probes:  ${STEM_PATH ? `VOCAL STEM (${basename(STEM_PATH)})` : 'RAW MIX'}`);
console.log(`Replay:  ${FROM.toFixed(1)}s → ${TO.toFixed(1)}s, tick ${TICK_MS}ms, buffer ${BUFFER_SEC}s`);
console.log(`Truth:   injected latency ${LATENCY.toFixed(3)}s → estimator should converge to ${(-LATENCY).toFixed(3)}s\n`);

// --- The simulated mic. ------------------------------------------------------
// Returns exactly BUFFER_SEC of audio whose newest sample is `LATENCY` seconds
// behind the playhead — i.e. what a real capture of delayed output contains.
const BUF_LEN = Math.round(BUFFER_SEC * SR);
function micAt(songNow) {
  const endSong = songNow - LATENCY;
  const startSong = endSong - BUFFER_SEC;
  const out = new Float32Array(BUF_LEN);
  const srcStart = Math.round(startSong * SR);
  for (let i = 0; i < BUF_LEN; i++) {
    const j = srcStart + i;
    out[i] = j >= 0 && j < probePcm.length ? probePcm[j] : 0;
  }
  return { sampleRate: SR, getOrderedPcm: () => out };
}

// --- Bridge shim: the loop is Electron-only, so stand in for the preload. ----
// Timing-only measurement (the path that decides lock) never calls the aligner
// or the separator, so a shim that reports "unavailable" replays the real
// pre-lock behaviour faithfully and keeps this runnable without a model.
const USE_CTC = has('ctc');
const bridge = {
  separateAvailable: async () => false,
  separateWarm: async () => false,
};

if (USE_CTC) {
  const { alignSong, alignAvailable } = await import('../electron/align.cjs');
  if (!alignAvailable()) {
    console.error('✗ --ctc needs @huggingface/transformers installed.');
    process.exit(1);
  }
  // align.js ships PCM over IPC as an ArrayBuffer; the real aligner wants a
  // Float32Array. Everything else passes through untouched.
  bridge.alignSong = async ({ pcm, sampleRate, searchPad, lines }) =>
    alignSong({
      pcm: pcm instanceof Float32Array ? pcm : new Float32Array(pcm),
      sampleRate,
      searchPad,
      lines,
    });
  bridge.alignWarm = async () => true;
}
global.window = { bar4bar: bridge };

const { refineTimelineFromMic, needsVocalAlign } = await import('../app/align.js');

// --- Replay. -----------------------------------------------------------------
const estimator = new SyncEstimator();
const timeline = { lines: JSON.parse(JSON.stringify(lines)) };
const allSamples = [];
const bySource = new Map();
const lockCounts = new Map();
const lockedErrors = [];
let firstLockAt = null;
let firstSampleAt = null;
let ticks = 0;

for (let now = FROM; now <= TO; now += TICK_MS / 1000) {
  ticks++;
  // Mirror liveAlignTick: pre-lock we're in timing-only mode, 3 lines/tick,
  // and once locked the loop keeps a slow drift-tracking trickle.
  const locked = estimator.suggestion() != null;
  const staleAfterSec = locked ? 10 : 3;
  // Exactly app.js liveAlignTick: pre-lock we're timing-only, and only once the
  // estimator has an answer does the loop move on to word refinement (which is
  // also the only path that produces the high-weight 'ctc' timing samples).
  const needsWords = USE_CTC ? needsVocalAlign(timeline, {}) : false;
  const autoNeedsSamples = !locked;
  const timingOnly = !needsWords || autoNeedsSamples;

  let res = false;
  try {
    res = await refineTimelineFromMic(timeline, micAt(now), now, {
      timingOnly,
      maxLines: timingOnly ? 3 : 2,
      expectedOffset: estimator.suggestion() ?? 0,
      staleAfterSec,
    });
  } catch (err) {
    console.error(`  tick @${now.toFixed(1)}s threw: ${err.message}`);
  }

  if (res && res.timingSamples?.length) {
    for (const s of res.timingSamples) {
      estimator.addSample(s);
      allSamples.push(s);
      const k = s.source || 'measured';
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k).push(s.value);
    }
    if (firstSampleAt == null) firstSampleAt = now;
  }

  const state = syncLockState(estimator, { autoOn: true });
  lockCounts.set(state, (lockCounts.get(state) || 0) + 1);
  if (state === 'locked' && firstLockAt == null) firstLockAt = now;
  // A single end-of-run number is hostage to whatever the last few samples did.
  // What the viewer actually experiences is the error at every moment the app
  // claims to be locked, so score that instead.
  if (state === 'locked') lockedErrors.push(Math.abs((estimator.value || 0) - -LATENCY));

  if (TRACE) {
    console.log(
      `  t=${now.toFixed(1).padStart(6)}s  n=${String(estimator.count).padStart(2)}  ` +
        `conf=${estimator.confidence.toFixed(2)}  val=${(estimator.value || 0).toFixed(3)}  ${state}`
    );
  }
}

// --- Report. -----------------------------------------------------------------
const values = allSamples.map((s) => s.value);
const mid = median(values);
const devs = values.map((v) => Math.abs(v - mid)).sort((a, b) => a - b);
const mad = devs.length ? devs[devs.length >> 1] : 0;
const truth = -LATENCY;
const finalVal = estimator.value || 0;

console.log('\n── SYNC LOCK ────────────────────────────────');
console.log(`  ticks replayed:      ${ticks}`);
console.log(`  timing samples:      ${allSamples.length}${firstSampleAt != null ? `  (first at ${firstSampleAt.toFixed(1)}s)` : ''}`);
console.log(`  time to LOCK:        ${firstLockAt == null ? '✗ never locked' : `${(firstLockAt - FROM).toFixed(1)}s into the replay`}`);
for (const [state, n] of [...lockCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${state.padEnd(12)} ${String(n).padStart(4)} ticks  (${((100 * n) / ticks).toFixed(0)}%)`);
}

console.log('\n── ACCURACY vs GROUND TRUTH ─────────────────');
console.log(`  injected latency:    ${LATENCY.toFixed(3)}s  → expected estimate ${truth.toFixed(3)}s`);
console.log(`  final estimate:      ${finalVal.toFixed(3)}s`);
console.log(`  final estimate error:${Math.abs(finalVal - truth).toFixed(3)}s`);
console.log(`  final confidence:    ${estimator.confidence.toFixed(2)}`);
// driftReadout calls anything inside 80ms "in sync" — same bar here.
const TOL = 0.08;
if (lockedErrors.length) {
  const medErr = median(lockedErrors);
  const good = lockedErrors.filter((e) => e <= TOL).length;
  console.log(`  median error WHILE LOCKED: ${medErr.toFixed(3)}s   ← what the viewer actually feels`);
  console.log(`  locked ticks within ${(TOL * 1000).toFixed(0)}ms:  ${good}/${lockedErrors.length}  (${((100 * good) / lockedErrors.length).toFixed(0)}%)`);
} else {
  console.log('  median error WHILE LOCKED: n/a (never locked)');
}

console.log('\n── WHY IT DID / DIDN\'T LOCK ─────────────────');
console.log(`  sample median:       ${mid.toFixed(3)}s`);
console.log(`  sample MAD:          ${mad.toFixed(3)}s   (scatter of the raw measurements)`);
// confidence = 1 − (1.253·MAD/√n)/agreeBand, so this is the bar the loop must clear.
const n = Math.max(1, values.length);
const sem = (1.253 * mad) / Math.sqrt(n);
console.log(`  → std err of median: ${sem.toFixed(3)}s vs agreeBand 0.120s`);
if (sem >= 0.12) {
  console.log('  ✗ scatter alone makes confidence 0 — the loop CANNOT lock on this material.');
} else if (firstLockAt == null) {
  console.log('  ~ scatter is survivable; lock likely blocked by sample COUNT, not spread.');
}
console.log('  by source:');
for (const [src, vals] of bySource) {
  const m = median(vals);
  const d = vals.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
  console.log(
    `    ${src.padEnd(11)} n=${String(vals.length).padStart(3)}  median=${m.toFixed(3)}s  ` +
      `MAD=${(d[d.length >> 1] ?? 0).toFixed(3)}s  err=${Math.abs(m - truth).toFixed(3)}s`
  );
}
console.log('\nA source whose median is far from the expected estimate is measuring the wrong thing.');
