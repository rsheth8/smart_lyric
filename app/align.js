// Forced-alignment refinement (desktop only).
//
// Decodes the current audio to 16 kHz mono in the renderer (Web Audio), sends it
// to the Electron main process (CTC acoustic model) for true per-word vocal
// timing, and patches the timeline's word start/end IN PLACE. Line start/end
// anchors are left untouched — we only sharpen the within-line word spread so the
// highlight tracks the singer. Soft-fails to a no-op wherever the bridge or model
// isn't available (web build, no audio, model download blocked), so the existing
// syllable/line timing always remains.

const TARGET_RATE = 16000;
const MIN_WORD_SCORE = 0.3; // below this the alignment is a guess — keep the estimate
const WINDOW_PAD_SEC = 0.25;

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

/** Desktop bridge present? (Forced alignment is Electron-only.) */
export function alignmentAvailable() {
  return typeof window !== 'undefined' && typeof window.bar4bar?.alignSong === 'function';
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

/**
 * Refine a timeline's word timings using its audio. Mutates `timeline` in place.
 * @returns {Promise<{aligned:number}|false>} false when unavailable/failed.
 */
export async function refineTimelineWithAudio(timeline, fileOrBuffer, { onStatus } = {}) {
  if (!alignmentAvailable() || !timeline?.lines?.length || !fileOrBuffer) return false;

  let pcm;
  try {
    onStatus?.('Decoding audio…');
    pcm = await decodeMono16k(fileOrBuffer);
  } catch {
    return false;
  }

  const lines = timeline.lines.map((l) => ({
    start: l.start,
    end: l.end,
    words: (l.words || []).map((w) => w.text),
  }));

  let result;
  try {
    onStatus?.('Aligning to the vocal…');
    result = await window.bar4bar.alignSong({ pcm: pcm.buffer, sampleRate: TARGET_RATE, lines });
  } catch {
    return false;
  }
  if (!result || result.error || !Array.isArray(result.lines)) return false;

  patchTimeline(timeline, result.lines);
  return { aligned: result.aligned || 0 };
}

/**
 * Vinyl / line-in: align recently-sung lines using the live mic ring buffer.
 * Runs incrementally (a few lines per call) so it keeps up in real time.
 * @returns {Promise<{aligned:number}|false>}
 */
export async function refineTimelineFromMic(timeline, mic, songNowSec, { maxLines = 2, onStatus } = {}) {
  if (!alignmentAvailable() || !timeline?.lines?.length || !mic) return false;
  const pcm = mic.getOrderedPcm?.();
  if (!pcm?.length) return false;
  const sampleRate = mic.sampleRate || 44100;
  const windowDur = pcm.length / sampleRate;
  const windowStart = songNowSec - windowDur;

  const candidates = timeline.lines
    .map((line, i) => ({ line, i }))
    .filter(
      ({ line }) =>
        !line._vocalAligned &&
        line.end <= songNowSec &&
        line.start >= windowStart &&
        (line.words?.length || 0) > 0
    )
    .slice(-maxLines);
  if (!candidates.length) return false;

  let aligned = 0;
  for (const { line } of candidates) {
    const ws = Math.max(windowStart, line.start - WINDOW_PAD_SEC);
    const we = Math.min(songNowSec, line.end + WINDOW_PAD_SEC);
    const i0 = Math.max(0, Math.floor((ws - windowStart) * sampleRate));
    const i1 = Math.min(pcm.length, Math.ceil((we - windowStart) * sampleRate));
    if (i1 - i0 < 800) continue;

    const slice = pcm.subarray(i0, i1);
    const pcm16k = resampleTo16k(slice, sampleRate);
    const relStart = line.start - ws;
    const relEnd = line.end - ws;

    let result;
    try {
      result = await window.bar4bar.alignSong({
        pcm: pcm16k.buffer,
        sampleRate: TARGET_RATE,
        lines: [{ start: relStart, end: relEnd, words: line.words.map((w) => w.text) }],
      });
    } catch {
      continue;
    }
    const al = result?.lines?.[0];
    if (!al?.words) continue;

    let patched = 0;
    al.words.forEach((span, j) => {
      const word = line.words[j];
      if (!word || !span) return;
      if (span.score != null && span.score < MIN_WORD_SCORE) return;
      if (!(span.end > span.start)) return;
      word.start = Math.max(line.start, ws + span.start);
      word.end = Math.min(line.end, ws + span.end);
      patched++;
    });
    if (patched > 0) {
      line._vocalAligned = true;
      aligned++;
    }
  }

  if (aligned > 0) timeline.aligned = true;
  return aligned > 0 ? { aligned } : false;
}

/** Apply aligned spans onto the timeline's word objects (guarded, in place). */
function patchTimeline(timeline, alignedLines) {
  alignedLines.forEach((al, i) => {
    const line = timeline.lines[i];
    if (!line || !al || !Array.isArray(al.words)) return;
    al.words.forEach((span, j) => {
      const word = line.words?.[j];
      if (!word || !span) return;
      if (span.score != null && span.score < MIN_WORD_SCORE) return;
      if (!(span.end > span.start)) return;
      // Keep words inside the line's anchor bounds.
      word.start = Math.max(line.start, span.start);
      word.end = Math.min(line.end, Math.max(span.end, span.start + 0.02));
    });
    // Restore monotonicity in case a low-score word was skipped between aligned ones.
    for (let k = 1; k < (line.words?.length || 0); k++) {
      if (line.words[k].start < line.words[k - 1].start) {
        line.words[k].start = line.words[k - 1].start;
        if (line.words[k].end < line.words[k].start) line.words[k].end = line.words[k].start + 0.02;
      }
    }
  });
  timeline.aligned = true;
}
