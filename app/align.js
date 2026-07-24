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
// Gaps shorter than this keep the karaoke wipe continuous; longer ones are real
// pauses and the word is allowed to end honestly instead of faking a hold.
const GAP_TOLERANCE_SEC = 0.35;

const WORD_SYNC_FORMATS = new Set(['yrc', 'richsync', 'ass']);
const LATIN_LETTER = /[A-Za-z]/;

/** Formats that already ship true per-word timing from a catalog. */
export function isWordSyncFormat(format) {
  return WORD_SYNC_FORMATS.has(format);
}

/**
 * True when we should try forced alignment (line/estimated timing, or catalog
 * word sync we still might refine — but we skip catalog word sync by default).
 * Completion is per-line (`_vocalAligned`): a single successful live/batch line
 * must NOT freeze the rest of the song out of CTC.
 */
export function needsVocalAlign(timeline, meta = {}) {
  if (!timeline?.lines?.length) return false;
  if (isWordSyncFormat(meta.format)) return false;
  return timeline.lines.some((l) => (l.words?.length || 0) > 0 && !l._vocalAligned);
}

/**
 * Set `timeline.aligned` only when every worded line has `_vocalAligned`.
 * Returns true when the timeline is fully aligned (safe to cache).
 */
export function markTimelineAlignedIfComplete(timeline) {
  if (!timeline?.lines?.length) {
    if (timeline) timeline.aligned = false;
    return false;
  }
  const eligible = timeline.lines.filter((l) => (l.words?.length || 0) > 0);
  const done = eligible.length > 0 && eligible.every((l) => l._vocalAligned);
  timeline.aligned = done;
  return done;
}

/**
 * Lines eligible for a latency measurement right now. Pure so the scheduling
 * rules are testable without audio.
 *
 * A line qualifies when it has words, has finished long enough ago that the
 * delayed audio has certainly reached the capture, still sits inside the mic ring
 * buffer, and hasn't been measured recently. `staleAfterSec` is what keeps the
 * loop alive: with `Infinity` every line is measured once and the loop then has
 * nothing to do for the rest of the song (no drift tracking). A finite value lets
 * lines come up for re-measurement so the estimate keeps tracking.
 *
 * @param {Array} lines
 * @param {number} nowSec song position
 * @param {{windowStart:number, pad?:number, maxLines?:number, staleAfterSec?:number}} opts
 */
export function pickTimingCandidates(
  lines,
  nowSec,
  { windowStart, pad = TIMING_SEARCH_PAD_SEC, maxLines = 3, staleAfterSec = Infinity } = {}
) {
  if (!Array.isArray(lines) || !Number.isFinite(nowSec)) return [];
  return lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => {
      if (!(line.words?.length > 0)) return false;
      if (!(line.end + pad <= nowSec)) return false; // not fully heard yet
      if (!(line.start - pad >= windowStart)) return false; // scrolled out of the buffer
      const at = line._timingMeasuredAt;
      if (at == null) return true;
      return nowSec - at >= staleAfterSec;
    })
    .slice(-maxLines);
}

// A mid-line word only gives a findable attack if it follows a real pause —
// estimateOnset needs a quiet frame before a candidate, and continuous singing
// never provides one.
const PROBE_MIN_GAP_SEC = 0.28;
const MAX_PROBES_PER_LINE = 3;
// A mid-line probe must land within this of its own line's entrance measurement,
// otherwise it found something that isn't the vocal (drum hit, ad-lib).
const WORD_PROBE_AGREE_SEC = 0.15;

/**
 * Points in a line worth measuring latency against: the line's entrance, plus
 * any word that starts after a real pause. Pure so the selection is testable.
 * @returns {Array<{expected:number, kind:'line'|'word'}>}
 */
export function timingProbePoints(line, { minGap = PROBE_MIN_GAP_SEC, max = MAX_PROBES_PER_LINE } = {}) {
  const words = line?.words || [];
  const first = words[0]?.start ?? line?.start;
  if (!Number.isFinite(first)) return [];
  const probes = [{ expected: first, kind: 'line' }];
  for (let i = 1; i < words.length && probes.length < max; i++) {
    const prev = words[i - 1];
    const gap = words[i].start - (prev.end ?? prev.start);
    if (gap >= minGap) probes.push({ expected: words[i].start, kind: 'word' });
  }
  return probes;
}

/**
 * True when auto-timing still needs to MEASURE speaker/output latency.
 *
 * Deliberately independent of `needsVocalAlign`. Word-level catalog timing (yrc/
 * richsync) and a cached already-aligned timeline both mean "the words are placed
 * correctly relative to each other" — they say nothing about how long the audio
 * takes to reach your ears. Conflating the two is why a word-sync or replayed
 * song measured nothing at all and the sync chip sat on "listening" forever.
 *
 * Hence: ignores `meta.format`, `timeline.aligned`, and `_vocalAligned`.
 */
export function needsLatencyCalib(timeline, { autoTiming = true } = {}) {
  if (!autoTiming) return false;
  if (!timeline?.lines?.length) return false;
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
 * Syllable attacks (seconds) inside [fromSec,toSec) — every clear energy rise,
 * not just the one nearest a guess. Only meaningful on an isolated vocal stem,
 * where energy IS voice; on a full mix these would be drum hits.
 *
 * This is what makes rubato tractable: interpolating words by syllable weight
 * assumes constant tempo, but a singer stretches and rushes. The attacks say
 * where the voice actually moved.
 */
export function detectOnsets(
  pcm,
  sampleRate,
  fromSec,
  toSec,
  { minE = 0.008, minRise = 0.004, minGapSec = 0.08 } = {}
) {
  if (!pcm?.length) return [];
  const i0 = Math.max(0, Math.floor(fromSec * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil(toSec * sampleRate));
  const frame = Math.max(16, Math.round(0.005 * sampleRate));
  const hop = Math.max(8, Math.round(0.0025 * sampleRate));
  if (i1 - i0 < frame + hop) return [];

  const env = [];
  for (let i = i0; i + frame <= i1; i += hop) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
    env.push({ time: (i + frame / 2) / sampleRate, value: Math.sqrt(sum / frame) });
  }
  const out = [];
  for (let k = 1; k < env.length - 1; k++) {
    const rise = env[k].value - env[k - 1].value;
    if (rise <= minRise || env[k].value <= minE) continue;
    if (env[k + 1].value - env[k].value > rise) continue; // keep the crest of the rise
    const t = env[k].time;
    if (out.length && t - out[out.length - 1] < minGapSec) continue;
    out.push(t);
  }
  return out;
}

/**
 * Where the voice actually stops after `fromSec`, or `limitSec` if it never does.
 *
 * This is what separates a genuinely HELD note from a word followed by silence.
 * Both look identical in the timeline — one word, then a long span before the
 * next — so without listening we'd either cut real holds short or fake a hold
 * over an instrumental gap. Only meaningful on an isolated vocal stem, where a
 * drop in energy really means the singer stopped.
 */
export function findVoiceEnd(
  pcm,
  sampleRate,
  fromSec,
  limitSec,
  { minE = 0.008, quietSec = 0.14 } = {}
) {
  if (!pcm?.length || !(limitSec > fromSec)) return limitSec;
  const i0 = Math.max(0, Math.floor(fromSec * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil(limitSec * sampleRate));
  const frame = Math.max(32, Math.round(0.02 * sampleRate));
  const hop = Math.max(16, Math.round(0.01 * sampleRate));
  if (i1 - i0 < frame + hop) return limitSec;

  let quietRun = 0;
  const needed = Math.max(1, Math.round(quietSec / 0.01));
  for (let i = i0; i + frame <= i1; i += hop) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
    const e = Math.sqrt(sum / frame);
    if (e < minE) {
      quietRun += 1;
      // Report where the quiet STARTED, not where we confirmed it.
      if (quietRun >= needed) return Math.max(fromSec, (i + frame / 2) / sampleRate - quietSec);
    } else {
      quietRun = 0;
    }
  }
  return limitSec;
}

/**
 * Pull evenly-spread guesses onto real syllable attacks, in order. A word with no
 * plausible attack nearby keeps its interpolated time, so this can only sharpen
 * placement — never invent it.
 */
function fitToOnsets(guess, onsets, tA, tB) {
  const n = guess.length;
  if (!n || !onsets?.length) return guess;
  const cand = onsets.filter((t) => t > tA + 0.02 && t < tB - 0.02);
  const c = cand.length;
  // Fewer attacks than words means we can't see where every word went (a slurred
  // run, a quiet passage). Redistributing on partial evidence risks being worse
  // than the even spread, so keep it.
  if (c < n) return guess;
  if (c === n) return cand.slice();

  // More attacks than words (melisma — one word carried over several attacks).
  // Choose n of them, in order, minimising total displacement from the guesses.
  // Deliberately NOT distance-capped: rubato moves words far from an even spread,
  // and that displacement is the signal, not noise. Order is what keeps it sane.
  const INF = Infinity;
  const cost = Array.from({ length: n }, () => new Float64Array(c).fill(INF));
  const back = Array.from({ length: n }, () => new Int32Array(c).fill(-1));
  for (let j = 0; j < c; j++) cost[0][j] = Math.abs(cand[j] - guess[0]);
  for (let m = 1; m < n; m++) {
    let bestPrev = INF;
    let bestIdx = -1;
    for (let j = 0; j < c; j++) {
      if (j > 0 && cost[m - 1][j - 1] < bestPrev) {
        bestPrev = cost[m - 1][j - 1];
        bestIdx = j - 1;
      }
      if (bestIdx >= 0) {
        cost[m][j] = bestPrev + Math.abs(cand[j] - guess[m]);
        back[m][j] = bestIdx;
      }
    }
  }
  let end = -1;
  let bestTotal = INF;
  for (let j = 0; j < c; j++) {
    if (cost[n - 1][j] < bestTotal) {
      bestTotal = cost[n - 1][j];
      end = j;
    }
  }
  if (end < 0) return guess;
  const out = new Array(n);
  for (let m = n - 1; m >= 0 && end >= 0; m--) {
    out[m] = cand[end];
    end = back[m][end];
  }
  return out.every((v) => Number.isFinite(v)) ? out : guess;
}

/**
 * Vocal-activity intervals from an isolated vocal stem. On a stem, energy IS
 * voice (instrumental ≈ silence), so a thresholded energy envelope tells the app
 * where someone is actually singing. Returns merged [{start,end}] in seconds.
 * Only meaningful on a stem — energy on the full mix is dominated by instruments.
 * @param {Float32Array} pcm  16 kHz mono vocal stem (song-time = index/sampleRate)
 * @param {{ mergeGapSec?: number, minDurSec?: number }} [opts]
 */
export function computeVocalIntervals(pcm, sampleRate, { mergeGapSec = 0.5, minDurSec = 0.2 } = {}) {
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
export function vocalStateAt(intervals, t, { pre = 0.2, post = 0.4 } = {}) {
  if (!intervals?.length) return { active: true, nextVocalIn: null }; // unknown → assume active
  let nextStart = null;
  for (const iv of intervals) {
    // Asymmetric: a held note decays slowly, so stay "singing" longer after the
    // interval ends than before it starts — a symmetric margin cut held tails
    // short and flashed ♪ over the end of a phrase.
    if (t >= iv.start - pre && t <= iv.end + post) return { active: true, nextVocalIn: 0 };
    if (iv.start > t && (nextStart == null || iv.start < nextStart)) nextStart = iv.start;
  }
  return { active: false, nextVocalIn: nextStart == null ? null : nextStart - t };
}

// ---- Instrumental smoothing -------------------------------------------------
// Raw vocal activity flips frame-to-frame on breaths and consonant dips, so
// rendering it directly makes the ♪ stutter in and out. The display state is
// therefore hysteretic: slow to enter (sustained quiet, and only for a gap worth
// announcing) and quick to leave (lyrics are back before the singer is).
export const INSTR_ENTER_SEC = 0.9; // sustained quiet before ♪ appears
// Only a real interlude deserves the ♪ takeover. At 2.5s this fired on ordinary
// breathing room between verses, so the indicator kept flashing up mid-song for
// pauses the singer never experienced as a break. A gap has to be long enough
// that a countdown genuinely helps you find your entrance again.
export const INSTR_MIN_GAP_SEC = 5.0;
export const INSTR_EXIT_LEAD_SEC = 0.5; // clear ♪ this long before the vocal returns

/**
 * Hysteretic instrumental state. Pure reducer — the caller keeps `prev` and
 * feeds the raw per-frame reading.
 * @param {{on: boolean, quietSince: number|null}|null} prev
 * @param {{quiet: boolean, nextVocalIn: number|null, t: number}} reading
 * @returns {{on: boolean, quietSince: number|null}}
 */
export function instrumentalState(prev, { quiet, nextVocalIn, t }, opts = {}) {
  const enterAfter = opts.enterAfter ?? INSTR_ENTER_SEC;
  const minGap = opts.minGap ?? INSTR_MIN_GAP_SEC;
  const exitLead = opts.exitLead ?? INSTR_EXIT_LEAD_SEC;
  const wasOn = !!prev?.on;

  if (!quiet) return { on: false, quietSince: null };

  const quietSince = prev?.quietSince == null ? t : prev.quietSince;
  // The vocal is about to return — clear early so the words lead the singer in.
  if (nextVocalIn != null && nextVocalIn <= exitLead) return { on: false, quietSince };
  if (wasOn) return { on: true, quietSince }; // already showing: no re-entry cost
  if (t - quietSince < enterAfter) return { on: false, quietSince };
  // Only announce a gap long enough to matter (quiet so far + what's left).
  const gap = nextVocalIn == null ? Infinity : t - quietSince + nextVocalIn;
  if (gap < minGap) return { on: false, quietSince };
  return { on: true, quietSince };
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
  // The first separation pays for model load, so it is always slow and must not
  // be counted when judging whether we can keep pace.
  firstSepSec: 0,
  firstWindowSec: 0,
  paused: false, // temporarily fell back to the raw mix because it couldn't keep up
  pausedAtMs: null, // when the auto-fallback flipped on (for cool-down retry)
  stemLines: 0, // lines word-aligned on an isolated stem
  rawLines: 0, // lines word-aligned on the raw mix
};

// Each live separation blocks the align loop while it runs, so separating slower
// than playback starves the very measurements it's meant to improve. Past this
// point a clean stem costs more than it's worth on the LIVE path (whole-file
// separation is unaffected — it isn't racing anything).
export const LIVE_SEP_MIN_REALTIME = 0.8;
export const LIVE_SEP_MIN_SAMPLES = 3; // ignore warm-up; need a real trend
// After falling behind, sit out this long then try again — CPU load and window
// length change mid-song, so a sticky permanent pause was too harsh.
export const LIVE_SEP_RETRY_AFTER_SEC = 25;

/**
 * Has live separation fallen far enough behind that we should drop to the raw
 * mix? Judged on the steady-state average with the warm-up window discounted.
 * Pure so the policy is testable without audio.
 */
export function shouldPauseLiveSeparation(
  stats,
  { minRealtime = LIVE_SEP_MIN_REALTIME, minSamples = LIVE_SEP_MIN_SAMPLES } = {}
) {
  if (!stats || stats.sepCount < minSamples) return false;
  const secs = stats.sepTotalSec - (stats.firstSepSec || 0);
  const windowSec = stats.sepTotalWindowSec - (stats.firstWindowSec || 0);
  if (!(secs > 0) || !(windowSec > 0)) return false;
  return windowSec / secs < minRealtime;
}

/**
 * Has the cool-down since an auto-fallback elapsed, so we should try stem
 * isolation again? Pure for tests.
 */
export function shouldResumeLiveSeparation(
  stats,
  nowMs = Date.now(),
  { retryAfterSec = LIVE_SEP_RETRY_AFTER_SEC } = {}
) {
  if (!stats?.paused) return false;
  if (stats.pausedAtMs == null) return true;
  return (nowMs - stats.pausedAtMs) / 1000 >= retryAfterSec;
}
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
  liveSepStats.firstSepSec = liveSepStats.firstWindowSec = 0;
  // Clear the auto-pause too: a new song (or a freed-up machine) deserves a
  // fresh attempt rather than staying degraded for the rest of the session.
  liveSepStats.paused = false;
  liveSepStats.pausedAtMs = null;
  liveSepStats.stemLines = liveSepStats.rawLines = 0;
  _emitLiveSep();
}

/** After a cool-down, clear the fallback and reset pace samples for a fresh try. */
function maybeResumeLiveSeparation() {
  if (!shouldResumeLiveSeparation(liveSepStats, nowMs())) return;
  liveSepStats.paused = false;
  liveSepStats.pausedAtMs = null;
  liveSepStats.sepCount = liveSepStats.sepTotalSec = liveSepStats.sepTotalWindowSec = 0;
  liveSepStats.firstSepSec = liveSepStats.firstWindowSec = 0;
  liveSepStats.lastRealtime = liveSepStats.lastWindowSec = null;
  console.log('[live-sep] retrying stem isolation after cool-down');
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
  if (liveSepStats.sepCount === 1) {
    liveSepStats.firstSepSec = sepSec; // warm-up: model load, not a fair sample
    liveSepStats.firstWindowSec = secs;
  }
  // Self-tune: if we can't keep pace, sit out for a cool-down rather than
  // blocking the align loop for longer than the audio we're analysing.
  if (!liveSepStats.paused && shouldPauseLiveSeparation(liveSepStats)) {
    liveSepStats.paused = true;
    liveSepStats.pausedAtMs = nowMs();
    console.log('[live-sep] slower than realtime — skipping stem for a bit, using raw mix');
  }
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
  // Auto-skipped after falling behind; retry after cool-down in case the machine
  // freed up. Raw mix keeps alignment moving while we sit out.
  maybeResumeLiveSeparation();
  if (liveSepStats.paused) return null;
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
    ? {
        minScore: 0.15,
        snap: { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 },
        // Stem only: on a full mix these 'onsets' are drum hits.
        onset: { minE: 0.004, minRise: 0.002 },
      }
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
      const onsetsIn = tuning.onset
        ? (fromAbs, toAbs) =>
            detectOnsets(windowPcm, TARGET_RATE, fromAbs - ws, toAbs - ws, tuning.onset).map(
              (t) => t + ws
            )
        : null;
      const voiceEndIn = tuning.onset
        ? (fromAbs, toAbs) =>
            findVoiceEnd(windowPcm, TARGET_RATE, fromAbs - ws, toAbs - ws, tuning.onset) + ws
        : null;
      batch.forEach(({ line, i }, k) => {
        const nextLineStart = timeline.lines[i + 1]?.start;
        if (
          applyWordSpans(line, result.lines[k]?.words, {
            onsetsIn,
            voiceEndIn,
            offsetSec: ws,
            floorSec,
            nextLineStart,
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
      if (markTimelineAlignedIfComplete(timeline)) _emitLiveSep();
      else if (aligned > 0) _emitLiveSep();
    }
    onProgress?.(done, targets.length);
  }

  markTimelineAlignedIfComplete(timeline);
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
  { maxLines = 2, timingOnly = false, expectedOffset = 0, staleAfterSec = Infinity, onStatus } = {}
) {
  if (!timeline?.lines?.length || !mic) return false;
  if (!timingOnly && !alignmentAvailable()) return false;
  const pcm = mic.getOrderedPcm?.();
  if (!pcm?.length) return false;
  const sampleRate = mic.sampleRate || 44100;
  const windowDur = pcm.length / sampleRate;
  const windowStart = songNowSec - windowDur;

  const candidates = timingOnly
    ? pickTimingCandidates(timeline.lines, songNowSec, {
        windowStart,
        pad: TIMING_SEARCH_PAD_SEC,
        maxLines,
        staleAfterSec,
      })
    : timeline.lines
        .map((line, i) => ({ line, i }))
        .filter(
          ({ line }) =>
            !line._vocalAligned &&
            line.end <= songNowSec &&
            line.start - ALIGN_SEARCH_PAD_SEC >= windowStart &&
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
      // Measure the line's own entrance AND any word inside it that follows a
      // real pause. One sample per line meant the estimator needed several
      // finished lines — tens of seconds — before it had enough agreement to
      // lock. Mid-line words that follow a breath give a clean attack to find,
      // so a single line can now contribute several independent measurements.
      const probes = timingProbePoints(line);
      let measuredAny = false;
      // Every probe in a line measures the SAME constant latency, so a mid-line
      // probe that disagrees with its own line's entrance didn't find that word —
      // it found a drum hit or an ad-lib. Corroboration is what makes the extra
      // samples worth having: unfiltered they scatter the estimate so badly the
      // median stops being trustworthy and the lock never happens.
      let lineValue = null;
      for (const probe of probes) {
        const center = probe.expected - Number(expectedOffset || 0);
        const ws = Math.max(windowStart, center - TIMING_SEARCH_PAD_SEC);
        const we = Math.min(
          songNowSec,
          center + TIMING_SEARCH_PAD_SEC,
          line.end + TIMING_SEARCH_PAD_SEC
        );
        const i0 = Math.max(0, Math.floor((ws - windowStart) * sampleRate));
        const i1 = Math.min(pcm.length, Math.ceil((we - windowStart) * sampleRate));
        if (i1 - i0 < Math.max(800, sampleRate * 0.25)) continue;

        const onset = estimateOnset(pcm.subarray(i0, i1), sampleRate);
        if (!onset) continue;
        const rawOnset = ws + onset.time;
        const value = probe.expected - rawOnset;
        if (probe.kind === 'line') {
          lineValue = value;
        } else if (lineValue == null || Math.abs(value - lineValue) > WORD_PROBE_AGREE_SEC) {
          continue; // uncorroborated — almost certainly not this word's attack
        }
        timingSamples.push({
          value,
          score: onset.score,
          // A line entrance follows a real gap so its attack is the cleanest
          // thing to find. Mid-line probes are noisier, and there can be two per
          // line — at anything close to parity they'd outweigh the clean signal.
          weight: probe.kind === 'line' ? 0.75 : 0.25,
          source: probe.kind === 'line' ? 'onset' : 'onset-word',
        });
        measuredAny = true;
      }
      if (measuredAny) line._timingMeasuredAt = songNowSec;
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
    ? {
        minScore: 0.15,
        snap: { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 },
        // Stem only: on a full mix these 'onsets' are drum hits.
        onset: { minE: 0.004, minRise: 0.002 },
      }
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
      // Capture-labeled times sit in "heard" coordinates (buffer end ≈ songNowSec).
      // syncOffset / expectedOffset is the measured hear-vs-catalog lag — convert
      // OUT before writing the canonical lyric timeline so display syncOffset
      // doesn't apply the same delay twice.
      const latency = Number(expectedOffset || 0);
      const sourceOrigin = batchStart + latency;
      const snap = (tAbs) =>
        snapToVocalOnset(batchPcm, TARGET_RATE, tAbs - sourceOrigin, tuning.snap) + sourceOrigin;
      const onsetsIn = tuning.onset
        ? (fromAbs, toAbs) =>
            detectOnsets(
              batchPcm,
              TARGET_RATE,
              fromAbs - sourceOrigin,
              toAbs - sourceOrigin,
              tuning.onset
            ).map((t) => t + sourceOrigin)
        : null;
      const voiceEndIn = tuning.onset
        ? (fromAbs, toAbs) =>
            findVoiceEnd(
              batchPcm,
              TARGET_RATE,
              fromAbs - sourceOrigin,
              toAbs - sourceOrigin,
              tuning.onset
            ) + sourceOrigin
        : null;
      for (let idx = 0; idx < candidates.length; idx++) {
        const { line, i } = candidates[idx];
        const al = result.lines[idx];
        if (!al?.words) continue;
        // Timing measurement from the raw (heard) onset, BEFORE latency conversion
        // and before applyWordSpans re-anchors.
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
          line._timingMeasuredAt = songNowSec;
        }
        if (timingOnly) continue;

        // Same refinement as the whole-file path: re-anchor + interpolate + snap,
        // and carry word.score / line.uncertain for the confidence-aware display.
        if (
          applyWordSpans(line, al.words, {
            offsetSec: sourceOrigin,
            floorSec,
            nextLineStart: timeline.lines[i + 1]?.start,
            snap,
            onsetsIn,
            voiceEndIn,
            minScore: tuning.minScore,
          })
        ) {
          aligned++;
          if (fromStem) liveSepStats.stemLines++;
          else liveSepStats.rawLines++;
        }
        floorSec = Math.max(floorSec, line.end);
      }
      markTimelineAlignedIfComplete(timeline);
      if (aligned > 0) _emitLiveSep();
      return aligned > 0 || timingSamples.length ? { aligned, timingSamples } : false;
    }
  }

  // Fallback for older bridges or an unexpected batch failure.
  for (const { line, i } of candidates) {
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
      line._timingMeasuredAt = songNowSec;
    }

    if (timingOnly) continue;

    // Legacy per-line path: convert capture lag out the same way as the batch path.
    const latency = Number(expectedOffset || 0);
    const sourceOrigin = ws + latency;
    const snap = (tAbs) => snapToVocalOnset(pcm16k, TARGET_RATE, tAbs - sourceOrigin) + sourceOrigin;
    if (
      applyWordSpans(line, al.words, {
        offsetSec: sourceOrigin,
        floorSec,
        nextLineStart: timeline.lines[i + 1]?.start,
        snap,
      })
    ) {
      aligned++;
      liveSepStats.rawLines++; // legacy per-line path never separates
    }
    floorSec = Math.max(floorSec, line.end);
  }

  markTimelineAlignedIfComplete(timeline);
  if (aligned > 0) _emitLiveSep();
  return aligned > 0 || timingSamples.length ? { aligned, timingSamples } : false;
}

const clampT = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const wordWeight = (w) => 0.4 + syllableCount(w?.text || '');

// Guards for back-extrapolating a line whose first word isn't a confident CTC
// anchor (see applyWordSpans step 2). Bound the inferred pace and how far back
// we're ever willing to drag a line start.
const SEC_PER_WEIGHT_MIN = 0.05;
const SEC_PER_WEIGHT_MAX = 0.5;
const MAX_LEAD_EXTRAPOLATION_SEC = 1.2;

/**
 * Seconds per syllable-weight unit — this line's local singing pace. Measured
 * between the outer CTC anchors when there are two (the real observed tempo for
 * this line); otherwise spread the catalog line span across all its words.
 */
function secPerWeight(words, anchors, lineStart, lineEnd) {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (last.i > first.i && last.start > first.start) {
    let w = 0;
    for (let k = first.i; k < last.i; k++) w += wordWeight(words[k]);
    if (w > 0) return clampT((last.start - first.start) / w, SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX);
  }
  let total = 0;
  for (const w of words) total += wordWeight(w);
  const span = lineEnd - lineStart;
  if (total > 0 && span > 0) return clampT(span / total, SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX);
  return 0.25;
}

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
  { back = 0.06, fwd = 0.03, minE = 0.008, minRise = 0.004, troughRatio = 0.55 } = {}
) {
  if (!pcm?.length) return tSec;
  const i0 = Math.max(0, Math.floor((tSec - back) * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil((tSec + fwd) * sampleRate));
  const frame = Math.max(16, Math.round(0.005 * sampleRate));
  const hop = Math.max(8, Math.round(0.0025 * sampleRate));
  if (i1 - i0 < frame + hop) return tSec;

  const env = [];
  for (let i = i0; i + frame <= i1; i += hop) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
    env.push({ time: (i + frame / 2) / sampleRate, value: Math.sqrt(sum / frame) });
  }
  let best = null;
  for (let k = 1; k < env.length; k++) {
    const rise = env[k].value - env[k - 1].value;
    if (rise > 0 && (!best || rise > best.rise)) {
      best = { idx: k, time: env[k].time, rise, e: env[k].value };
    }
  }
  // Only move to a clear rise; otherwise the CTC estimate stands. On a clean vocal
  // stem the gate is relaxed (callers pass a lower minE/minRise + wider window).
  if (!best || !(best.e > minE && best.rise > minRise)) return tSec;
  // Gap guard: a candidate BEHIND the estimate is only the same sound if energy
  // stays up all the way to the estimate. If it dips into a trough first, that
  // rise belongs to an earlier, separate event (breath, drum hit, room noise) —
  // snapping onto it would fire the word early, so keep the CTC time.
  if (best.time < tSec) {
    for (let k = best.idx; k < env.length && env[k].time <= tSec; k++) {
      if (env[k].value < best.e * troughRatio) return tSec;
    }
  }
  return best.time;
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
  {
    offsetSec = 0,
    floorSec = -Infinity,
    nextLineStart = null,
    snap = null,
    onsetsIn = null,
    voiceEndIn = null,
    minScore = MIN_WORD_SCORE,
  } = {}
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
  const anchorEnd = new Map(anchors.map((a) => [a.i, a.end]));

  // 2. Re-anchor the line to the real vocal (bounded by the previous line's end).
  const originalEnd = line.end;
  const originalStart = line.start;
  let lineStart = anchors[0].start;
  // The line's true first word often isn't a confident anchor: soft consonants
  // (h/s/f/th) and swelling held vowels score low, so the first ANCHOR can be
  // word 2 or 3. Anchoring the line there fires the highlight late while the
  // singer is already on word 1 — the "late off the jump" feel. Back-extrapolate
  // to word 0 at this line's own pace, then let the onset snap confirm it: snap
  // only moves onto a real energy rise, so a bad guess degrades to the
  // extrapolated time rather than inventing an onset.
  if (anchors[0].i > 0) {
    const pace = secPerWeight(words, anchors, originalStart, originalEnd);
    let leadWeight = 0;
    for (let k = 0; k < anchors[0].i; k++) leadWeight += wordWeight(words[k]);
    const back = Math.min(leadWeight * pace, MAX_LEAD_EXTRAPOLATION_SEC);
    let est = anchors[0].start - back;
    if (snap) est = snap(est);
    lineStart = est;
  }
  // Cap against the next line so re-anchoring can't create overlapping ranges
  // that make the display jump between two "current" lines.
  const endCap =
    Number.isFinite(nextLineStart) && nextLineStart > floorSec ? nextLineStart - 0.02 : Infinity;
  line.start = clampT(
    lineStart,
    floorSec,
    Math.min(anchors[0].start, originalEnd - 0.1, Number.isFinite(endCap) ? endCap : Infinity)
  );
  line.end = Math.min(Math.max(originalEnd, anchors[anchors.length - 1].end), endCap);
  if (!(line.end > line.start)) line.end = line.start + 0.05;

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
    const guess = [];
    idxs.forEach((k, m) => {
      guess.push(t);
      t += (weights[m] / total) * span;
    });
    // The even spread above assumes constant tempo. When we can see the vocal's
    // real syllable attacks (stem only), prefer those — that's what rubato moves.
    // A held note pushes the following attack late, so the held word simply keeps
    // the time instead of the spread stealing it.
    const placed = onsetsIn ? fitToOnsets(guess, onsetsIn(tA, tB), tA, tB) : guess;
    idxs.forEach((k, m) => {
      starts[k] = placed[m];
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
  // 5. Word ends, from the best evidence available.
  //
  //    Ends used to be purely "wherever the next word starts", with the last word
  //    stretched to line.end. That makes every pause look like a held note and
  //    dumps all of a line's slack onto its final word — the highlight races past
  //    a genuinely elongated word mid-verse, then the last word sits lit forever.
  //
  //    In order of trust: the CTC span's own end (it measures duration, and works
  //    on a full mix); where the voice actually stops (stem only — on a full mix
  //    energy never really drops, so this correctly no-ops); otherwise the old
  //    contiguous behaviour. A gap smaller than GAP_TOLERANCE still stretches to
  //    the next word so normal singing keeps one smooth continuous wipe.
  for (let k = 0; k < words.length; k++) {
    const start = starts[k];
    const nextStart = k + 1 < words.length ? starts[k + 1] : line.end;
    // Voice first: it's a direct measurement of when sound stops, and CTC tends
    // to emit a token early and under-measure a sustained vowel — the exact case
    // where a held note must keep its full length.
    let natural = null;
    if (voiceEndIn) natural = voiceEndIn(start, nextStart);
    else if (anchorEnd.has(k)) natural = Math.min(anchorEnd.get(k), nextStart);
    words[k].start = start;
    words[k].end =
      natural == null || nextStart - natural <= GAP_TOLERANCE_SEC ? nextStart : natural;
    if (words[k].end <= words[k].start) words[k].end = words[k].start + 0.02;
    words[k].score = anchorScore.has(k) ? anchorScore.get(k) : 0;
  }
  // Mostly-interpolated line → per-word timing is a guess; flag for line-level UI.
  line._alignCoverage = anchors.length / words.length;
  line.uncertain = line._alignCoverage < UNCERTAIN_COVERAGE;
  line._vocalAligned = true;
  return true;
}

// ---- Live in-progress-line retiming (rubato, before the line finishes) ----
//
// refineTimelineFromMic only ever corrects a line AFTER it's fully sung
// (candidate filter above requires line.end <= songNowSec) — useless for the
// highlight during a tempo change mid-line. These two functions add a lighter,
// onset-only pass (no CTC/IPC round trip beyond one separation call) that
// retimes the NOT-YET-REACHED words of the line currently being sung, so a
// rubato swing is caught within the line instead of after it.

const LIVE_RETIME_REACHED_MARGIN_SEC = 0.15; // how "in the past" a word must be to be untouchable
const LIVE_RETIME_MIN_MATCHED = 2; // need >=2 onset/word pairs before trusting a pace
const LIVE_RETIME_MIN_REARM_SEC = 1.5; // min gap between separation attempts on one line
const LIVE_RETIME_MIN_CHANGE_SEC = 0.05; // skip a correction too small to be worth the jitter risk

/**
 * Pure core of live rubato retiming. Given a line's CURRENT word estimate and
 * onsets observed so far in [lineStart, nowSec), re-spread only the words the
 * display hasn't reached yet using the locally observed singing pace instead
 * of the original tempo-blind estimate. Returns null (no-op) whenever the
 * evidence is too weak to trust — never invents a correction from a guess.
 *
 * Never mutates `words` — reached words are load-bearing for what the display
 * already rendered, and rewriting one would show as a visible jump.
 *
 * @param {Array<{start:number,end:number,text?:string}>} words  line.words,
 *   current estimated timing.
 * @param {number} nowSec
 * @param {{lineStart:number, lineEnd:number, onsets:number[],
 *   margin?:number, minMatched?:number}} opts  `onsets` are song-time seconds
 *   (same clock as start/end); re-filtered defensively to [lineStart, nowSec).
 * @returns {null | Array<{index:number, start:number, end:number}>} patches
 *   (word index + new start/end) to apply, or null.
 */
export function computeLiveRetime(
  words,
  nowSec,
  {
    lineStart,
    lineEnd,
    onsets,
    margin = LIVE_RETIME_REACHED_MARGIN_SEC,
    minMatched = LIVE_RETIME_MIN_MATCHED,
  } = {}
) {
  if (!Array.isArray(words) || words.length < 2) return null;
  if (!(lineEnd > lineStart) || !Number.isFinite(nowSec)) return null;

  const clean = Array.from(
    new Set((onsets || []).filter((t) => Number.isFinite(t) && t >= lineStart && t < nowSec))
  ).sort((a, b) => a - b);
  if (clean.length < minMatched) return null;

  // "Reached" = the current estimate already thinks this word has started —
  // the display has committed to it. Starts are monotonic, so reached is
  // always a prefix.
  let reachedCut = -1;
  for (let i = 0; i < words.length; i++) {
    if (Number.isFinite(words[i]?.start) && words[i].start <= nowSec - margin) reachedCut = i;
    else break;
  }
  if (reachedCut < 0) return null; // line just started, nothing to anchor on
  if (reachedCut + 1 >= words.length) return null; // already on the last word

  // Tail-pair the most recent reached words against the most recent onsets, in
  // order. No distance gate: a large displacement IS the rubato signal (same
  // philosophy as fitToOnsets above) — rejecting it would defeat the purpose.
  const n = Math.min(reachedCut + 1, clean.length);
  if (n < minMatched) return null;
  const anchorFirst = { i: reachedCut + 1 - n, t: clean[clean.length - n] };
  const anchorLast = { i: reachedCut, t: clean[clean.length - 1] };
  if (!(anchorLast.t > anchorFirst.t)) return null;

  let weightSpan = 0;
  for (let k = anchorFirst.i; k < anchorLast.i; k++) weightSpan += wordWeight(words[k]);
  if (!(weightSpan > 0)) return null;
  const pace = clampT((anchorLast.t - anchorFirst.t) / weightSpan, SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX);

  const lastIdx = words.length - 1;
  let weightAfterAnchor = 0;
  for (let k = anchorLast.i; k < lastIdx; k++) weightAfterAnchor += wordWeight(words[k]);
  if (!(weightAfterAnchor > 0)) return null;
  const available = lineEnd - 0.02 - anchorLast.t;
  const effectivePace =
    available > 0 && weightAfterAnchor * pace > available ? available / weightAfterAnchor : pace;
  if (!(effectivePace > 0)) return null;

  // Floor at the LATER of "now" and the last reached word's own (untouched)
  // .end — never schedule the next word to start before the still-"current"
  // reached word finishes (both would render as current simultaneously).
  const floorStart = Math.max(
    nowSec + 0.02,
    Number.isFinite(words[reachedCut].end) ? words[reachedCut].end : words[reachedCut].start + 0.02
  );

  const patches = [];
  let cum = 0;
  let prev = floorStart - 0.02;
  for (let k = reachedCut + 1; k <= lastIdx; k++) {
    cum += wordWeight(words[k - 1]);
    const raw = anchorLast.t + cum * effectivePace;
    const s = clampT(raw, prev + 0.02, lineEnd - 0.02);
    patches.push({ index: k, start: s });
    prev = s;
  }
  for (let m = 0; m < patches.length; m++) {
    patches[m].end = m + 1 < patches.length ? patches[m + 1].start : lineEnd;
  }

  // Skip a no-meaningful-change result — avoid jitter/CSS churn when the
  // observed pace roughly matches the existing estimate already.
  const changed = patches.some((p) => Math.abs(p.start - words[p.index].start) > LIVE_RETIME_MIN_CHANGE_SEC);
  return changed ? patches : null;
}

/**
 * Live sibling of refineTimelineFromMic, but for the line CURRENTLY being
 * sung. Onset evidence only — no CTC/IPC round trip beyond one separation
 * call, so it can run every tick regardless of the CTC bootstrapping state.
 * Mutates the in-progress line's not-yet-reached words in place; sets
 * `line._liveRetimedAt` (distinct from `_vocalAligned`, which is reserved for
 * a real CTC pass — see applyWordSpans above) so a later full CTC pass on
 * this line is never skipped because of this lighter live pass.
 * @returns {Promise<boolean>} true when a line's words were actually retimed.
 */
export async function retimeCurrentLineFromMic(
  timeline,
  mic,
  songNowSec,
  { onStatus, minRearmSec = LIVE_RETIME_MIN_REARM_SEC } = {}
) {
  if (!timeline?.lines?.length || !mic || !Number.isFinite(songNowSec)) return false;

  const line = timeline.lines.find(
    (l) =>
      l.start <= songNowSec &&
      songNowSec < l.end &&
      (l.words?.length || 0) > 1 &&
      !l._vocalAligned &&
      (l._liveRetimedAt == null || songNowSec - l._liveRetimedAt >= minRearmSec)
  );
  if (!line) return false;

  const pcm = mic.getOrderedPcm?.();
  if (!pcm?.length) return false;
  const sampleRate = mic.sampleRate || 44100;
  const windowStart = songNowSec - pcm.length / sampleRate;
  // Mirrors the bound check in refineTimelineFromMic's candidate filter above.
  if (!(line.start - ALIGN_SEARCH_PAD_SEC >= windowStart)) return false;

  const i0 = Math.max(0, Math.floor((line.start - windowStart) * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil((songNowSec - windowStart) * sampleRate));
  if (i1 - i0 < 800) return false;

  // Isolate the vocal for just this line's elapsed span; micWindowStem no-ops
  // (returns null) when separation is unavailable/paused/too-short. We NEVER
  // fall back to onset-detecting the raw mix — drum hits masquerade as
  // syllable attacks there (see detectOnsets/applyWordSpans comments above).
  const stem = await micWindowStem(pcm.subarray(i0, i1), sampleRate, { onStatus });
  line._liveRetimedAt = songNowSec; // recorded whether or not this attempt finds anything
  if (!stem?.length) return false;

  const onsets = detectOnsets(stem, TARGET_RATE, 0, songNowSec - line.start, {
    minE: 0.004,
    minRise: 0.002,
  }).map((t) => t + line.start);

  const patches = computeLiveRetime(line.words, songNowSec, {
    lineStart: line.start,
    lineEnd: line.end,
    onsets,
  });
  if (!patches) return false;
  for (const p of patches) {
    line.words[p.index].start = p.start;
    line.words[p.index].end = p.end;
  }
  return true;
}

