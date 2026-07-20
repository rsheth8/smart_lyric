// Forced-alignment refinement (desktop only).
//
// Decodes the current audio to 16 kHz mono in the renderer (Web Audio), sends it
// to the Electron main process (CTC acoustic model) for true per-word vocal
// timing, and patches the timeline's word start/end IN PLACE. Three refinements
// beyond raw CTC (see applyWordSpans): (1) re-anchor each line to the first
// confident vocal onset instead of trusting the catalog's line start; (2)
// interpolate low-confidence words *between* confident anchors by syllable weight
// rather than dropping them to a heuristic guess; (3) snap each start to the
// nearest local energy onset. Soft-fails to a no-op wherever the bridge or model
// isn't available (web build, no audio, model download blocked), so the existing
// syllable/line timing always remains.

import { syllableCount } from './providers/formats/lrc.js';

const TARGET_RATE = 16000;
const MIN_WORD_SCORE = 0.3; // below this the alignment is a guess — interpolate instead
// When fewer than this fraction of a line's words were confidently aligned (the
// rest interpolated), we don't trust the per-word timing — the display degrades
// that line to a line-level highlight instead of a jittery word-by-word claim.
const UNCERTAIN_COVERAGE = 0.6;
// Search window for refinement so early word entries / held tails that
// fall outside the catalog's line anchor can still be found (enables re-anchoring).
const ALIGN_SEARCH_PAD_SEC = 0.6;
// Auto-timing must discover output latency that can be much larger than the
// normal word-refinement pad (Bluetooth/soundbars are often 0.5–1.2s).
const TIMING_SEARCH_PAD_SEC = 1.5;
const ONSET_FRAME_SEC = 0.025;
const ONSET_HOP_SEC = 0.01;
const MIN_ONSET_SCORE = 0.45;
// Whole-file alignment runs in small line batches so early lines sharpen while
// the rest is still being aligned (and each IPC payload stays a few seconds of
// audio, not the whole song).
const ALIGN_BATCH_LINES = 6;

const WORD_SYNC_FORMATS = new Set(['yrc', 'richsync', 'ass']);
const LATIN_LETTER = /[A-Za-z]/;

/** Formats that already ship true per-word timing from a catalog. */
export function isWordSyncFormat(format) {
  return WORD_SYNC_FORMATS.has(format);
}

/**
 * True when we should try forced alignment (line/estimated timing, or catalog
 * word sync we still might refine — but we skip catalog word sync by default).
 */
export function needsVocalAlign(timeline, meta = {}) {
  if (!timeline?.lines?.length) return false;
  if (timeline.aligned) return false;
  if (isWordSyncFormat(meta.format)) return false;
  return timeline.lines.some((l) => (l.words?.length || 0) > 0);
}

/**
 * Words to feed the CTC model for a line. Prefer romanization when the sung
 * text isn't Latin — wav2vec2-base-960h only knows A–Z.
 */
export function alignableWordTexts(line) {
  const words = line?.words || [];
  if (!words.length) return [];
  const joined = words.map((w) => w.text).join(' ');
  if (LATIN_LETTER.test(joined) || !line.roman) {
    return words.map((w) => w.text);
  }
  // Split romanization into the same number of tokens when possible; otherwise
  // fall back to original (aligner will drop out-of-vocab chars).
  const romanTokens = String(line.roman).trim().split(/\s+/).filter(Boolean);
  if (romanTokens.length === words.length) return romanTokens;
  return words.map((w) => w.text);
}

/** Linear resample (e.g. 44.1 kHz line-in → 16 kHz for the aligner). */
export function resampleTo16k(samples, fromRate = 44100) {
  const ratio = fromRate / TARGET_RATE;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = a + frac * (b - a);
  }
  return out;
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor((s.length - 1) * p)));
  return s[idx];
}

function rmsEnvelope(samples, sampleRate) {
  const frame = Math.max(64, Math.round(ONSET_FRAME_SEC * sampleRate));
  const hop = Math.max(32, Math.round(ONSET_HOP_SEC * sampleRate));
  const out = [];
  for (let i = 0; i + frame <= samples.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    out.push({ time: (i + frame / 2) / sampleRate, value: Math.sqrt(sum / frame) });
  }
  return out;
}

/**
 * Cheap onset detector for auto-timing. It does not know lyrics; it looks for the
 * first clear energy rise in the wide line window. We weight it lower than CTC so
 * consistent quick samples can lock early, while bad beat/instrument hits get
 * outvoted by stronger alignment samples later.
 */
export function estimateOnset(samples, sampleRate) {
  const env = rmsEnvelope(samples, sampleRate);
  if (env.length < 4) return null;
  const values = env.map((e) => e.value);
  const floor = percentile(values, 0.25);
  const peak = percentile(values, 0.95);
  const spread = peak - floor;
  if (peak < 0.006 || spread < 0.004) return null;

  const threshold = floor + spread * 0.38;
  const quiet = floor + spread * 0.18;
  let wasQuiet = true;
  let best = null;

  for (let i = 1; i < env.length - 1; i++) {
    if (env[i - 1].value <= quiet) wasQuiet = true;
    const sustained = env[i].value >= threshold && env[i + 1].value >= threshold;
    if (!wasQuiet || !sustained) continue;
    const rise = env[i].value - env[i - 1].value;
    const prominence = (env[i].value - floor) / spread;
    const score = Math.max(0, Math.min(1, prominence * 0.75 + Math.max(0, rise / spread) * 0.25));
    if (!best || score > best.score) best = { time: env[i].time, score };
    wasQuiet = false;
    // The earliest plausible onset is usually best for a lyric line.
    if (score >= 0.75) break;
  }

  return best && best.score >= MIN_ONSET_SCORE ? best : null;
}

/**
 * Vocal-activity intervals from an isolated vocal stem. On a stem, energy IS
 * voice (instrumental ≈ silence), so a thresholded energy envelope tells the app
 * where someone is actually singing. Returns merged [{start,end}] in seconds.
 * Only meaningful on a stem — energy on the full mix is dominated by instruments.
 * @param {Float32Array} pcm  16 kHz mono vocal stem (song-time = index/sampleRate)
 * @param {{ mergeGapSec?: number, minDurSec?: number }} [opts]
 */
export function computeVocalIntervals(pcm, sampleRate, { mergeGapSec = 0.35, minDurSec = 0.2 } = {}) {
  const env = rmsEnvelope(pcm, sampleRate);
  if (env.length < 4) return [];
  const values = env.map((e) => e.value);
  const floor = percentile(values, 0.2);
  const peak = percentile(values, 0.9);
  const spread = Math.max(1e-6, peak - floor);
  // Relative threshold with a small absolute floor so a fully-silent stem yields
  // no intervals rather than noise-triggered ones.
  const threshold = Math.max(0.01, floor + 0.15 * spread);

  const intervals = [];
  let cur = null;
  for (const e of env) {
    if (e.value > threshold) {
      if (!cur) cur = { start: e.time, end: e.time };
      else cur.end = e.time;
    } else if (cur) {
      intervals.push(cur);
      cur = null;
    }
  }
  if (cur) intervals.push(cur);

  // Bridge short gaps (breaths, consonant dips) then drop blips.
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end <= mergeGapSec) last.end = iv.end;
    else merged.push({ ...iv });
  }
  return merged.filter((iv) => iv.end - iv.start >= minDurSec);
}

/**
 * Vocal state at time `t` given sorted `intervals`. `active` allows a small margin
 * so we don't flicker at edges; `nextVocalIn` is seconds until the next interval
 * starts (null if none ahead). Pure — used by the display each frame.
 */
export function vocalStateAt(intervals, t, { margin = 0.25 } = {}) {
  if (!intervals?.length) return { active: true, nextVocalIn: null }; // unknown → assume active
  let nextStart = null;
  for (const iv of intervals) {
    if (t >= iv.start - margin && t <= iv.end + margin) return { active: true, nextVocalIn: 0 };
    if (iv.start > t && (nextStart == null || iv.start < nextStart)) nextStart = iv.start;
  }
  return { active: false, nextVocalIn: nextStart == null ? null : nextStart - t };
}

/**
 * Infer instrumental stretches from lyric timing when no stem-derived vocal map
 * exists. Catalog/estimated timelines park leftover span on the last word of a
 * line (`wordsAcrossSpan` held tail), so a long bridge before the next line
 * looks like a stretched final word. Once that word has held for `maxHoldSec`,
 * treat the rest of the gap as instrumental — same `{active, nextVocalIn}` shape
 * as `vocalStateAt`, so the display can show the ♪ indicator.
 *
 * Only fires when the leftover after the hold is a real interlude (`minGapSec`),
 * not a normal breath between lines.
 *
 * @param {Array<{ start: number, end?: number, words?: Array<{ start: number, end: number }> }>} lines
 * @param {number} t
 * @param {{ maxHoldSec?: number, minGapSec?: number }} [opts]
 */
export function lyricGapStateAt(lines, t, { maxHoldSec = 2.0, minGapSec = 1.5 } = {}) {
  if (!lines?.length) return { active: true, nextVocalIn: null };

  const first = lines[0];
  if (t < first.start) {
    const nextIn = first.start - t;
    // Long intro → instrumental; short lead-in stays "active" so we don't flash ♪.
    if (nextIn > minGapSec) return { active: false, nextVocalIn: nextIn };
    return { active: true, nextVocalIn: nextIn };
  }

  let li = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start) li = i;
    else break;
  }
  if (li < 0) return { active: true, nextVocalIn: first.start - t };

  const line = lines[li];
  const next = lines[li + 1];
  const nextStart = next ? next.start : null;
  const words = line.words || [];

  // When singing on this line is "done" for display: last word may hold briefly,
  // then any long leftover until the next line is the interlude.
  let sungUntil;
  if (!words.length) {
    sungUntil = line.start;
  } else {
    const last = words[words.length - 1];
    sungUntil = Math.min(last.end, last.start + maxHoldSec);
  }
  const gapEnd = nextStart != null ? nextStart : (Number.isFinite(line.end) ? line.end : sungUntil);
  const leftover = gapEnd - sungUntil;

  if (leftover >= minGapSec && t >= sungUntil && (nextStart == null || t < nextStart)) {
    return { active: false, nextVocalIn: nextStart == null ? null : nextStart - t };
  }

  // Past the last line's end with no more lyrics ahead.
  if (!next && Number.isFinite(line.end) && t >= line.end) {
    return { active: false, nextVocalIn: null };
  }

  return {
    active: true,
    nextVocalIn: nextStart != null && nextStart > t ? nextStart - t : null,
  };
}

/** Desktop bridge present? (Forced alignment is Electron-only.) */
export function alignmentAvailable() {
  return typeof window !== 'undefined' && typeof window.bar4bar?.alignSong === 'function';
}

/** Kick off the ~90 MB model download/load without blocking playback. */
export async function warmAlignModel() {
  if (!alignmentAvailable()) return false;
  try {
    if (typeof window.bar4bar.alignWarm === 'function') {
      return !!(await window.bar4bar.alignWarm());
    }
    // Older preload: a no-op probe still triggers model load on first alignSong.
    return true;
  } catch {
    return false;
  }
}

/** Decode any browser-supported audio into a 16 kHz mono Float32Array. */
export async function decodeMono16k(fileOrBuffer) {
  const arrayBuf =
    fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  // A throwaway context just to decode (sample rate here doesn't matter).
  const decodeCtx = new Ctx(1, 1, 44100);
  const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
  // Render/resample to 16 kHz mono.
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const off = new Ctx(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

/** Desktop vocal-separation bridge present AND a model configured? (async IPC.) */
export async function separationAvailable() {
  try {
    return !!(await window.bar4bar?.separateAvailable?.());
  } catch {
    return false;
  }
}

/** Prefetch the separation model in the background (no-op when unconfigured). */
export async function warmSeparationModel() {
  try {
    return !!(await window.bar4bar?.separateWarm?.());
  } catch {
    return false;
  }
}

// User preference (Sync menu) layered on top of model availability. Default on so
// that once a model is configured it's used; the toggle lets the user disable it.
let _separationEnabled = true;
export function setVocalSeparationEnabled(on) {
  _separationEnabled = !!on;
}
export function vocalSeparationEnabled() {
  return _separationEnabled;
}

/** Decode audio into stereo Float32 channels at `rate` (for the separator). */
export async function decodeStereo(fileOrBuffer, rate = 44100) {
  const arrayBuf =
    fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const decodeCtx = new Ctx(1, 1, 44100);
  const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new Ctx(2, frames, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
  return { left, right, sampleRate: rate };
}

/**
 * Isolate the vocal stem and return it as 16 kHz mono for CTC. Aligning on the
 * isolated vocal (instead of the full mix) is the biggest accuracy lever. Returns
 * null when separation is unavailable or fails — the caller then aligns the mix.
 */
export async function vocalStemMono16k(fileOrBuffer, { onStatus } = {}) {
  if (!_separationEnabled) return null;
  if (!(await separationAvailable())) return null;
  let stereo;
  try {
    onStatus?.('Isolating the vocal…');
    stereo = await decodeStereo(fileOrBuffer, 44100);
  } catch {
    return null;
  }
  beginSeparation(); // immediate HUD feedback while the whole song separates
  const secs = stereo.left.length / (stereo.sampleRate || 44100);
  const t0 = nowMs();
  let res;
  try {
    res = await window.bar4bar.separateVocals({
      left: stereo.left.buffer,
      right: stereo.right.buffer,
      sampleRate: stereo.sampleRate,
    });
  } catch {
    endSeparation();
    return null;
  }
  if (!res?.left) {
    endSeparation();
    return null;
  }
  const asF32 = (b) => (b instanceof Float32Array ? b : new Float32Array(b));
  const L = asF32(res.left);
  const R = res.right ? asF32(res.right) : L;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + (R[i] ?? L[i]));
  const stem16k = resampleTo16k(mono, res.sampleRate || 44100);
  recordSeparation(secs, (nowMs() - t0) / 1000);
  return stem16k;
}

// Live (mic/loopback) vocal separation, toggled independently of the file path so
// it can be A/B'd: `localStorage.sl_live_sep = '0'` (then reload) disables it.
let _liveSeparationEnabled = true;
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('sl_live_sep') === '0') {
    _liveSeparationEnabled = false;
  }
} catch {
  /* no localStorage (tests / SSR) — default on */
}
export function setLiveVocalSeparationEnabled(on) {
  _liveSeparationEnabled = !!on;
  try {
    localStorage.setItem('sl_live_sep', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
export function liveVocalSeparationEnabled() {
  return _liveSeparationEnabled;
}

// Live-separation diagnostics for an on-screen HUD (does it keep up? stem vs raw?).
const liveSepStats = {
  separating: false, // a separation is in flight right now (immediate HUD feedback)
  lastRealtime: null, // × realtime of the most recent separation (<1 ⇒ falling behind)
  lastWindowSec: null,
  sepCount: 0,
  sepTotalSec: 0, // wall-clock spent separating
  sepTotalWindowSec: 0, // audio-seconds separated (for the running average)
  stemLines: 0, // lines word-aligned on an isolated stem
  rawLines: 0, // lines word-aligned on the raw mix
};
let _liveSepListener = null;
/** Subscribe to live-separation diagnostics (one listener; for the HUD). */
export function onLiveSepStat(fn) {
  _liveSepListener = typeof fn === 'function' ? fn : null;
}
export function liveSeparationStats() {
  return { ...liveSepStats };
}
export function resetLiveSeparationStats() {
  liveSepStats.separating = false;
  liveSepStats.lastRealtime = liveSepStats.lastWindowSec = null;
  liveSepStats.sepCount = liveSepStats.sepTotalSec = liveSepStats.sepTotalWindowSec = 0;
  liveSepStats.stemLines = liveSepStats.rawLines = 0;
  _emitLiveSep();
}
function _emitLiveSep() {
  try {
    _liveSepListener?.(liveSeparationStats());
  } catch {
    /* a HUD error must never break alignment */
  }
}
// Shared by both separation paths (file-whole-song and live mic-window) so the HUD
// and [live-sep] logs fire for either. `beginSeparation` gives immediate feedback.
function beginSeparation() {
  liveSepStats.separating = true;
  _emitLiveSep();
}
function recordSeparation(secs, sepSec) {
  liveSepStats.separating = false;
  liveSepStats.lastWindowSec = secs;
  liveSepStats.lastRealtime = sepSec > 0 ? secs / sepSec : null;
  liveSepStats.sepCount += 1;
  liveSepStats.sepTotalSec += sepSec;
  liveSepStats.sepTotalWindowSec += secs;
  _emitLiveSep();
  if (sepSec > 0) {
    console.log(`[live-sep] ${secs.toFixed(1)}s → ${sepSec.toFixed(1)}s (${(secs / sepSec).toFixed(1)}× realtime)`);
  }
}
function endSeparation() {
  // Clear the in-flight flag on a failed/empty separation (no count recorded).
  if (liveSepStats.separating) {
    liveSepStats.separating = false;
    _emitLiveSep();
  }
}

const MIN_STEM_WINDOW_SEC = 2.0; // below this, MDX's fixed cost isn't worth it
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Isolate the vocal from ONE live align window (mono @ sampleRate) and return it as
 * 16 kHz mono for CTC, or null to fall back to the raw mix. Scoped to the ~2-line
 * batch so MDX's ~1.3× realtime cost stays bounded; logs the realtime factor so we
 * can confirm the live loop keeps up. Dense mixes align far better on the stem
 * (measured 12%→0% line-level fallback on loopback-captured Nirvana). Phase 3a.
 */
async function micWindowStem(monoPcm, sampleRate, { onStatus } = {}) {
  if (!_separationEnabled || !_liveSeparationEnabled) return null;
  if (!(monoPcm?.length > 0)) return null;
  const secs = monoPcm.length / sampleRate;
  if (secs < MIN_STEM_WINDOW_SEC) return null;
  if (!(await separationAvailable())) return null;
  beginSeparation();
  try {
    onStatus?.('Isolating the vocal…');
    // Copy into own buffers (a ring-buffer subarray shares the whole ring's buffer),
    // and give L/R distinct buffers in case the IPC transfers them.
    const left = Float32Array.from(monoPcm);
    const right = Float32Array.from(monoPcm);
    const t0 = nowMs();
    const res = await window.bar4bar.separateVocals({ left: left.buffer, right: right.buffer, sampleRate });
    if (!res?.left) {
      endSeparation();
      return null;
    }
    const asF32 = (b) => (b instanceof Float32Array ? b : new Float32Array(b));
    const L = asF32(res.left);
    const R = res.right ? asF32(res.right) : L;
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + (R[i] ?? L[i]));
    const stem16k = resampleTo16k(mono, res.sampleRate || 44100);
    recordSeparation(secs, (nowMs() - t0) / 1000);
    return stem16k;
  } catch {
    endSeparation();
    return null;
  }
}

/**
 * Refine a timeline's word timings using its audio (clean local file). Mutates
 * `timeline` in place and applies each batch as soon as it aligns, so the lines
 * about to be sung sharpen first instead of the whole song landing at once.
 * @param {File|Blob|ArrayBuffer|Float32Array} fileOrBuffer  source audio, or
 *   pre-decoded 16 kHz mono PCM (Float32Array) — the latter skips Web Audio decode.
 * @param {{ onStatus?: Function, onProgress?: (done:number,total:number)=>void,
 *           batchLines?: number }} [opts]
 * @returns {Promise<{aligned:number, error?:string}|false>} false when unavailable.
 */
export async function refineTimelineWithAudio(
  timeline,
  fileOrBuffer,
  { onStatus, onProgress, batchLines = ALIGN_BATCH_LINES } = {}
) {
  if (!alignmentAvailable() || !timeline?.lines?.length || !fileOrBuffer) return false;

  let pcm;
  let fromStem = false;
  if (fileOrBuffer instanceof Float32Array) {
    pcm = fileOrBuffer; // already 16 kHz mono (test / pre-decoded callers)
  } else {
    // Prefer the isolated vocal stem (far cleaner for CTC); fall back to the raw
    // mix when separation is unavailable or fails.
    pcm = await vocalStemMono16k(fileOrBuffer, { onStatus });
    if (pcm?.length) {
      fromStem = true;
    } else {
      try {
        onStatus?.('Decoding audio…');
        pcm = await decodeMono16k(fileOrBuffer);
      } catch {
        return false;
      }
    }
  }

  // A clean vocal stem lets us trust more CTC words and snap onsets aggressively;
  // the raw mix keeps the conservative gates (a drum hit isn't a vocal onset).
  const tuning = fromStem
    ? { minScore: 0.15, snap: { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 } }
    : { minScore: MIN_WORD_SCORE, snap: {} };

  // Vocal-activity map (stem only): lets the display show an instrumental state
  // instead of parking a highlight through a solo. Energy on the mix is not vocal.
  if (fromStem) timeline.vocalIntervals = computeVocalIntervals(pcm, TARGET_RATE);

  const durSec = pcm.length / TARGET_RATE;
  // Only lines still needing vocal timing (skip catalog word-sync / already done).
  const targets = timeline.lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => (line.words?.length || 0) > 0 && !line._vocalAligned);
  if (!targets.length) return timeline.aligned ? { aligned: 0 } : false;

  let aligned = 0;
  let done = 0;
  // Lower bound for the next re-anchored line.start, so re-anchoring can't make a
  // line start before the previous one ends. Seeded below the first line.
  let floorSec = targets[0].line.start - ALIGN_SEARCH_PAD_SEC;
  for (let b = 0; b < targets.length; b += batchLines) {
    const batch = targets.slice(b, b + batchLines);
    const first = batch[0].line;
    const last = batch[batch.length - 1].line;
    // Widen the window by the search pad so early entries / held tails outside the
    // catalog's line anchors are inside the audio we send.
    const ws = Math.max(0, first.start - ALIGN_SEARCH_PAD_SEC);
    const we = Math.min(durSec, last.end + ALIGN_SEARCH_PAD_SEC);
    const i0 = Math.max(0, Math.floor(ws * TARGET_RATE));
    const i1 = Math.min(pcm.length, Math.ceil(we * TARGET_RATE));
    done += batch.length;
    if (i1 - i0 < 800) {
      onProgress?.(done, targets.length);
      continue;
    }

    // Copy the window (subarray().buffer would ship the whole song), rebase line
    // times into the window so the aligner's per-line slicing lands correctly.
    const windowPcm = pcm.slice(i0, i1);
    const batchInput = batch.map(({ line }) => ({
      start: line.start - ws,
      end: line.end - ws,
      words: alignableWordTexts(line),
    }));

    let result;
    try {
      onStatus?.(`Aligning to the vocal… ${done}/${targets.length}`);
      result = await window.bar4bar.alignSong({
        pcm: windowPcm.buffer,
        sampleRate: TARGET_RATE,
        searchPad: ALIGN_SEARCH_PAD_SEC,
        lines: batchInput,
      });
    } catch {
      onProgress?.(done, targets.length);
      continue;
    }
    if (result?.error) {
      // Model unavailable/failed — stop and let the caller surface it (don't leave
      // the user silently on estimated timing).
      return { aligned, error: result.error };
    }
    if (Array.isArray(result?.lines)) {
      // Snap onto the local vocal-energy onset within this window (window-relative).
      const snap = (tAbs) => snapToVocalOnset(windowPcm, TARGET_RATE, tAbs - ws, tuning.snap) + ws;
      batch.forEach(({ line }, k) => {
        if (
          applyWordSpans(line, result.lines[k]?.words, {
            offsetSec: ws,
            floorSec,
            snap,
            minScore: tuning.minScore,
          })
        ) {
          aligned++;
          if (fromStem) liveSepStats.stemLines++;
          else liveSepStats.rawLines++;
        }
        floorSec = Math.max(floorSec, line.end); // keep lines ordered across batches
      });
      if (aligned > 0) {
        timeline.aligned = true;
        _emitLiveSep();
      }
    }
    onProgress?.(done, targets.length);
  }

  return aligned > 0 || timeline.aligned ? { aligned } : false;
}

/**
 * Vinyl / line-in / Spotify loopback: align recently-sung lines using a live
 * PCM ring buffer. Runs incrementally so it keeps up in real time.
 * @param {{ maxLines?: number, timingOnly?: boolean, expectedOffset?: number, onStatus?: Function }} [opts]
 * @returns {Promise<{aligned:number,timingSamples:Array<number|{value:number,score?:number,weight?:number,source?:string}>}|false>}
 */
export async function refineTimelineFromMic(
  timeline,
  mic,
  songNowSec,
  { maxLines = 2, timingOnly = false, expectedOffset = 0, onStatus } = {}
) {
  if (!timeline?.lines?.length || !mic) return false;
  if (!timingOnly && !alignmentAvailable()) return false;
  const pcm = mic.getOrderedPcm?.();
  if (!pcm?.length) return false;
  const sampleRate = mic.sampleRate || 44100;
  const windowDur = pcm.length / sampleRate;
  const windowStart = songNowSec - windowDur;

  const candidates = timeline.lines
    .map((line, i) => ({ line, i }))
    .filter(
      ({ line }) =>
        // Timing calibration is independent from word refinement: catalog and
        // cached word-sync lines still need one latency measurement.
        (timingOnly ? !line._timingMeasured : !line._vocalAligned) &&
        // Wait until the full delayed line should have reached the capture.
        line.end + (timingOnly ? TIMING_SEARCH_PAD_SEC : 0) <= songNowSec &&
        line.start - (timingOnly ? TIMING_SEARCH_PAD_SEC : ALIGN_SEARCH_PAD_SEC) >= windowStart &&
        (line.words?.length || 0) > 0
    )
    .slice(-maxLines);
  if (!candidates.length) return false;

  // Lower bound for re-anchoring line starts, kept ordered (as in the whole-file path).
  let floorSec = candidates[0].line.start - ALIGN_SEARCH_PAD_SEC;
  let aligned = 0;
  const timingSamples = []; // measured (line.start − rawVocalOnset) per line, for auto-sync

  if (timingOnly) {
    for (const { line } of candidates) {
      const expectedOnset = line.words?.[0]?.start ?? line.start;
      const center = expectedOnset - Number(expectedOffset || 0);
      const ws = Math.max(windowStart, center - TIMING_SEARCH_PAD_SEC);
      const we = Math.min(songNowSec, center + TIMING_SEARCH_PAD_SEC, line.end + TIMING_SEARCH_PAD_SEC);
      const i0 = Math.max(0, Math.floor((ws - windowStart) * sampleRate));
      const i1 = Math.min(pcm.length, Math.ceil((we - windowStart) * sampleRate));
      if (i1 - i0 < Math.max(800, sampleRate * 0.25)) continue;

      const onset = estimateOnset(pcm.subarray(i0, i1), sampleRate);
      if (!onset) continue;
      const rawOnset = ws + onset.time;
      timingSamples.push({
        value: expectedOnset - rawOnset,
        score: onset.score,
        weight: 0.75,
        source: 'onset',
      });
      line._timingMeasured = true;
    }
    if (timingSamples.length) return { aligned: 0, timingSamples };
    if (!alignmentAvailable()) return false;
  }

  const batchStart = Math.max(
    windowStart,
    Math.min(...candidates.map(({ line }) => line.start - (timingOnly ? TIMING_SEARCH_PAD_SEC : ALIGN_SEARCH_PAD_SEC)))
  );
  const batchEnd = Math.min(
    songNowSec,
    Math.max(...candidates.map(({ line }) => line.end + (timingOnly ? TIMING_SEARCH_PAD_SEC : ALIGN_SEARCH_PAD_SEC)))
  );
  const bi0 = Math.max(0, Math.floor((batchStart - windowStart) * sampleRate));
  const bi1 = Math.min(pcm.length, Math.ceil((batchEnd - windowStart) * sampleRate));
  // On the word-refinement pass, isolate the vocal for this window first (dense
  // mixes align far better on the stem); fall back to the raw mix when separation
  // is unavailable/too-short/fails. Timing-only passes stay on the raw mix.
  let batchPcm = null;
  let fromStem = false;
  if (bi1 - bi0 >= 800) {
    const rawWin = pcm.subarray(bi0, bi1);
    const stem16k = timingOnly ? null : await micWindowStem(rawWin, sampleRate, { onStatus });
    if (stem16k?.length) {
      batchPcm = stem16k;
      fromStem = true;
    } else {
      batchPcm = resampleTo16k(rawWin, sampleRate);
    }
  }
  // A clean stem lets us trust more CTC words and snap onsets aggressively; the raw
  // mix keeps the conservative gates (a drum hit isn't a vocal onset).
  const tuning = fromStem
    ? { minScore: 0.15, snap: { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 } }
    : { minScore: MIN_WORD_SCORE, snap: {} };
  const batchLines = batchPcm
    ? candidates.map(({ line }) => ({
        // Rebase to the window; alignSong's searchPad supplies the ± search room
        // (matches refineTimelineWithAudio — no double-padding).
        start: timingOnly ? 0 : Math.max(0, line.start - batchStart),
        end: timingOnly ? batchPcm.length / TARGET_RATE : Math.min(batchEnd - batchStart, line.end - batchStart),
        words: alignableWordTexts(line),
      }))
    : [];

  if (batchPcm && batchLines.length) {
    let result;
    try {
      onStatus?.('Aligning to the vocal…');
      result = await window.bar4bar.alignSong({
        pcm: batchPcm.buffer,
        sampleRate: TARGET_RATE,
        searchPad: ALIGN_SEARCH_PAD_SEC,
        lines: batchLines,
      });
    } catch {
      result = null;
    }
    if (Array.isArray(result?.lines)) {
      const snap = (tAbs) => snapToVocalOnset(batchPcm, TARGET_RATE, tAbs - batchStart, tuning.snap) + batchStart;
      for (let idx = 0; idx < candidates.length; idx++) {
        const { line } = candidates[idx];
        const al = result.lines[idx];
        if (!al?.words) continue;
        // Timing measurement from the raw onset, BEFORE applyWordSpans re-anchors.
        const firstSpan = al.words.find(
          (s) => s && s.end > s.start && (s.score == null || s.score >= MIN_WORD_SCORE)
        );
        if (firstSpan) {
          const rawOnset = batchStart + firstSpan.start;
          const expectedOnset = line.words?.[0]?.start ?? line.start;
          timingSamples.push({
            value: expectedOnset - rawOnset,
            score: firstSpan.score ?? 1,
            weight: 2.25,
            source: 'ctc',
          });
          line._timingMeasured = true;
        }
        if (timingOnly) continue;

        // Same refinement as the whole-file path: re-anchor + interpolate + snap,
        // and carry word.score / line.uncertain for the confidence-aware display.
        if (applyWordSpans(line, al.words, { offsetSec: batchStart, floorSec, snap, minScore: tuning.minScore })) {
          aligned++;
          if (fromStem) liveSepStats.stemLines++;
          else liveSepStats.rawLines++;
        }
        floorSec = Math.max(floorSec, line.end);
      }
      if (aligned > 0) {
        timeline.aligned = true;
        _emitLiveSep();
      }
      return aligned > 0 || timingSamples.length ? { aligned, timingSamples } : false;
    }
  }

  // Fallback for older bridges or an unexpected batch failure.
  for (const { line } of candidates) {
    const pad = timingOnly ? TIMING_SEARCH_PAD_SEC : ALIGN_SEARCH_PAD_SEC;
    const ws = Math.max(windowStart, line.start - pad);
    const we = Math.min(songNowSec, line.end + pad);
    const i0 = Math.max(0, Math.floor((ws - windowStart) * sampleRate));
    const i1 = Math.min(pcm.length, Math.ceil((we - windowStart) * sampleRate));
    if (i1 - i0 < 800) continue;

    const slice = pcm.subarray(i0, i1);
    const pcm16k = resampleTo16k(slice, sampleRate);
    // In timing-only mode let CTC search the entire wide window. Passing the
    // original narrow anchors would clip a delayed vocal before it can be found.
    const relStart = timingOnly ? 0 : line.start - ws;
    const relEnd = timingOnly ? pcm16k.length / TARGET_RATE : line.end - ws;

    let result;
    try {
      result = await window.bar4bar.alignSong({
        pcm: pcm16k.buffer,
        sampleRate: TARGET_RATE,
        searchPad: ALIGN_SEARCH_PAD_SEC,
        lines: [{ start: relStart, end: relEnd, words: alignableWordTexts(line) }],
      });
    } catch {
      continue;
    }
    const al = result?.lines?.[0];
    if (!al?.words) continue;

    // Measure the timeline-vs-audio shift from the FIRST confidently aligned word,
    // BEFORE clamping into the line — that raw onset is where the vocal truly is.
    const firstSpan = al.words.find((s) => s && s.end > s.start && (s.score == null || s.score >= MIN_WORD_SCORE));
    if (firstSpan) {
      const rawOnset = ws + firstSpan.start; // song-time of the real vocal onset
      const expectedOnset = line.words?.[0]?.start ?? line.start;
      timingSamples.push({
        value: expectedOnset - rawOnset, // +ve ⇒ show lyrics earlier
        score: firstSpan.score ?? 1,
        weight: 2.25,
        source: 'ctc',
      });
      line._timingMeasured = true;
    }

    if (timingOnly) continue;

    const snap = (tAbs) => snapToVocalOnset(pcm16k, TARGET_RATE, tAbs - ws) + ws;
    if (applyWordSpans(line, al.words, { offsetSec: ws, floorSec, snap })) {
      aligned++;
      liveSepStats.rawLines++; // legacy per-line path never separates
    }
    floorSec = Math.max(floorSec, line.end);
  }

  if (aligned > 0) {
    timeline.aligned = true;
    _emitLiveSep();
  }
  return aligned > 0 || timingSamples.length ? { aligned, timingSamples } : false;
}

const clampT = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const wordWeight = (w) => 0.4 + syllableCount(w?.text || '');

/**
 * Find a local vocal-energy onset near `tSec` and return the adjusted time. CTC
 * tends to place a word slightly after its true acoustic onset; snapping to the
 * nearest short-term energy rise in a tiny window tightens perceived sync. Kept
 * deliberately conservative (small window + prominence gate) so on a full mix it
 * no-ops rather than snapping to an unrelated drum hit. Exported for testing.
 */
export function snapToVocalOnset(
  pcm,
  sampleRate,
  tSec,
  { back = 0.06, fwd = 0.03, minE = 0.008, minRise = 0.004 } = {}
) {
  if (!pcm?.length) return tSec;
  const i0 = Math.max(0, Math.floor((tSec - back) * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil((tSec + fwd) * sampleRate));
  const frame = Math.max(16, Math.round(0.005 * sampleRate));
  const hop = Math.max(8, Math.round(0.0025 * sampleRate));
  if (i1 - i0 < frame + hop) return tSec;

  let prevE = null;
  let best = null;
  for (let i = i0; i + frame <= i1; i += hop) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
    const e = Math.sqrt(sum / frame);
    if (prevE != null) {
      const rise = e - prevE;
      if (rise > 0 && (!best || rise > best.rise)) best = { time: (i + frame / 2) / sampleRate, rise, e };
    }
    prevE = e;
  }
  // Only move to a clear rise; otherwise the CTC estimate stands. On a clean vocal
  // stem the gate is relaxed (callers pass a lower minE/minRise + wider window).
  if (best && best.e > minE && best.rise > minRise) return best.time;
  return tSec;
}

/**
 * Apply aligned CTC word spans onto one line's word objects, in place. Beyond raw
 * CTC this (1) re-anchors line.start to the first confident vocal onset — bounded
 * below by `floorSec` (the previous line's end) so lines stay ordered; (2) keeps
 * confident words as anchors and interpolates the uncertain ones between them by
 * syllable weight, instead of dropping them to a heuristic guess; (3) snaps each
 * start to a local energy onset via `snap(tAbs)`. Word ends are made contiguous
 * (each holds until the next word; the last holds to line end).
 * @param {{ offsetSec?: number, floorSec?: number, snap?: (t:number)=>number }} [opts]
 * @returns {boolean} true when at least one confident anchor was applied.
 */
function applyWordSpans(
  line,
  spans,
  { offsetSec = 0, floorSec = -Infinity, snap = null, minScore = MIN_WORD_SCORE } = {}
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

  // 2. Re-anchor the line to the real vocal (bounded by the previous line's end).
  const originalEnd = line.end;
  line.start = clampT(anchors[0].start, floorSec, originalEnd - 0.1);
  line.end = Math.max(originalEnd, anchors[anchors.length - 1].end);

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
    idxs.forEach((k, m) => {
      starts[k] = t;
      t += (weights[m] / total) * span;
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
  // 5. Contiguous ends (last word holds the tail to line end). Per-word CTC score
  //    rides along (interpolated words get 0) so the display can tell what it knows.
  for (let k = 0; k < words.length; k++) {
    words[k].start = starts[k];
    words[k].end = k + 1 < words.length ? starts[k + 1] : line.end;
    if (words[k].end <= words[k].start) words[k].end = words[k].start + 0.02;
    words[k].score = anchorScore.has(k) ? anchorScore.get(k) : 0;
  }
  // Mostly-interpolated line → per-word timing is a guess; flag for line-level UI.
  line._alignCoverage = anchors.length / words.length;
  line.uncertain = line._alignCoverage < UNCERTAIN_COVERAGE;
  line._vocalAligned = true;
  return true;
}

