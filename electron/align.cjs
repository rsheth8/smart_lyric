// CTC forced alignment (Electron main process).
//
// Refines the *within-line* word timings of a timeline using the actual vocal:
// line START/END anchors (from richsync/LRC) stay put, but each word's start/end
// is recomputed from where it's really sung, instead of the mechanical syllable
// spread. This is the "moves with the singer" step of the timing plan.
//
// How: a wav2vec2 CTC acoustic model (via Transformers.js / onnxruntime-node)
// produces per-frame character log-probabilities; `lib/forced-align.mjs` aligns
// the known lyric text to those frames (CTC segmentation), and we map frames back
// to seconds. We run ONE short inference per line window (a few seconds each) so
// memory/compute stay bounded — a whole-song pass would blow up wav2vec2's full
// self-attention (O(n²)) on multi-minute audio.
//
// Model constraints: the 960h English/Latin acoustic models share one vocab, so
// non-Latin lyrics should be aligned via their romanization upstream. Everything
// soft-fails to null → the caller keeps the existing line-level/syllable timing.

const os = require('node:os');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const WINDOW_PAD_SEC = 0.25; // widen each line window so onsets/tails aren't clipped
const MIN_WINDOW_SAMPLES = 800; // ~50 ms; below this the model has nothing to chew

// Presets share wav2vec2 CTC character vocabs (pad=0, '|'=4). "high" uses the
// publicly available Xenova ONNX build of a large English XLSR model — there is
// no Xenova export of facebook/wav2vec2-large-960h-lv60 (that id 401s).
const ALIGN_MODEL_PRESETS = {
  default: 'Xenova/wav2vec2-base-960h',
  high: 'Xenova/wav2vec2-large-xlsr-53-english',
};

function resolveInitialModel() {
  if (process.env.ALIGN_MODEL && process.env.ALIGN_MODEL.trim()) {
    return process.env.ALIGN_MODEL.trim();
  }
  return ALIGN_MODEL_PRESETS.default;
}

let ALIGN_MODEL = resolveInitialModel();

// Canonical facebook/wav2vec2-base-960h vocab (its HF repo ships no
// tokenizer_config.json, so AutoTokenizer can't build it). The ONNX classifier
// output is ordered by these ids. Blank = <pad> = 0, word separator '|' = 4.
const WAV2VEC2_960H_VOCAB = {
  '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4, E: 5, T: 6, A: 7, O: 8,
  N: 9, I: 10, H: 11, S: 12, R: 13, D: 14, L: 15, U: 16, M: 17, W: 18, C: 19,
  F: 20, G: 21, Y: 22, P: 23, B: 24, V: 25, K: 26, "'": 27, X: 28, J: 29, Q: 30, Z: 31,
};

// jonatasgrosman / Xenova wav2vec2-large-xlsr-53-english — lowercase + hyphen.
const WAV2VEC2_XLSR_EN_VOCAB = {
  '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4, "'": 5, '-': 6,
  a: 7, b: 8, c: 9, d: 10, e: 11, f: 12, g: 13, h: 14, i: 15, j: 16, k: 17,
  l: 18, m: 19, n: 20, o: 21, p: 22, q: 23, r: 24, s: 25, t: 26, u: 27, v: 28,
  w: 29, x: 30, y: 31, z: 32,
};

/** Pick the CTC char map for a model id. `buildTranscript` already case-folds. */
function vocabForModel(modelId) {
  const id = String(modelId || '');
  if (id.includes('xlsr') || id === ALIGN_MODEL_PRESETS.high) return WAV2VEC2_XLSR_EN_VOCAB;
  return WAV2VEC2_960H_VOCAB;
}

let _tf = null;
let _modelP = null;
let _helpersP = null;
let _modelFailed = false;
let _modelFailedReason = null;

async function tf() {
  if (!_tf) {
    _tf = await import('@huggingface/transformers');
    // Cache downloaded models in a stable per-user dir (survives app updates).
    _tf.env.cacheDir = path.join(os.homedir(), '.cache', 'bar4bar-transformers');
    _tf.env.allowLocalModels = false;
  }
  return _tf;
}

async function helpers() {
  if (!_helpersP) {
    _helpersP = Promise.all([
      import('../lib/forced-align.mjs'),
      import('../lib/align-text.mjs'),
    ]).then(([fa, at]) => ({ ...fa, ...at }));
  }
  return _helpersP;
}

async function getModel() {
  if (_modelFailed) throw new Error(_modelFailedReason || 'align model unavailable');
  if (_modelP) return _modelP;
  _modelP = (async () => {
    const { AutoModelForCTC, AutoProcessor } = await tf();
    const model = await AutoModelForCTC.from_pretrained(ALIGN_MODEL);
    // The processor (feature extractor) is optional — if its config is missing we
    // fall back to manual zero-mean/unit-variance normalization (what wav2vec2's
    // extractor does for base models).
    let processor = null;
    try {
      processor = await AutoProcessor.from_pretrained(ALIGN_MODEL);
    } catch {
      processor = null;
    }
    return {
      model,
      processor,
      vocab: vocabForModel(ALIGN_MODEL),
      blankId: 0,
      separatorId: 4,
    };
  })().catch((e) => {
    _modelP = null;
    _modelFailed = true;
    _modelFailedReason = e.message || String(e);
    throw e;
  });
  return _modelP;
}

/** True when the acoustic model finished loading (not merely that the dep exists). */
function alignModelLoaded() {
  return !!_modelP && !_modelFailed;
}

/** Current model id + which preset it matches (if any). */
function alignModelStatus() {
  const preset =
    Object.keys(ALIGN_MODEL_PRESETS).find((k) => ALIGN_MODEL_PRESETS[k] === ALIGN_MODEL) || null;
  return {
    model: ALIGN_MODEL,
    preset,
    loaded: alignModelLoaded(),
    failed: _modelFailed,
    reason: _modelFailedReason,
    presets: { ...ALIGN_MODEL_PRESETS },
  };
}

/**
 * Switch acoustic model. `presetOrId` is `"default"` / `"high"` or a full HF id.
 * Clears the loaded model so the next warm/align downloads the new one.
 * Env `ALIGN_MODEL` still wins on process start; this is the in-app override.
 */
function setAlignModel(presetOrId) {
  const raw = String(presetOrId || '').trim();
  if (!raw) return alignModelStatus();
  const next = ALIGN_MODEL_PRESETS[raw] || raw;
  if (next === ALIGN_MODEL && !_modelFailed) return alignModelStatus();
  ALIGN_MODEL = next;
  _modelP = null;
  _modelFailed = false;
  _modelFailedReason = null;
  return alignModelStatus();
}

/** Start downloading/loading the model in the background. Returns true on success. */
async function alignWarm() {
  if (_modelFailed) return false;
  try {
    await getModel();
    return true;
  } catch {
    return false;
  }
}

/** Zero-mean / unit-variance normalize (wav2vec2 base feature extraction). */
function normalize(samples) {
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;
  let varSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = samples[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / (samples.length || 1)) + 1e-7;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] - mean) / std;
  return out;
}

/** Run the acoustic model over one PCM window → [numFrame][numLabel] log-probs. */
async function emissionFor(samples, model, processor) {
  const { Tensor } = await tf();
  let inputs;
  if (processor) {
    inputs = await processor(samples);
  } else {
    inputs = { input_values: new Tensor('float32', normalize(samples), [1, samples.length]) };
  }
  const out = await model(inputs);
  const logits = out.logits; // dims [1, numFrame, numLabel]
  const [, numFrame, numLabel] = logits.dims;
  const data = logits.data; // flat Float32Array
  const emission = new Float32Array(numFrame * numLabel);
  for (let f = 0; f < numFrame; f++) {
    const base = f * numLabel;
    // log_softmax across labels for numerical stability.
    let max = -Infinity;
    for (let l = 0; l < numLabel; l++) {
      const v = data[base + l];
      if (v > max) max = v;
    }
    let sum = 0;
    for (let l = 0; l < numLabel; l++) sum += Math.exp(data[base + l] - max);
    const logDen = max + Math.log(sum);
    for (let l = 0; l < numLabel; l++) emission[base + l] = data[base + l] - logDen;
  }
  return { emission: { data: emission, numFrame, numLabel }, numFrame };
}

/**
 * Align one song. Line start/end anchors are trusted; words within each line are
 * re-timed from the audio.
 * @param {{ pcm: ArrayBuffer|Float32Array, sampleRate?: number,
 *           lines: {start:number,end:number,words:string[]}[] }} payload
 * @returns {Promise<{ lines: {words: ({start:number,end:number,score:number}|null)[]}[],
 *                     model: string, aligned: number }|null>}
 */
async function alignSong(payload) {
  const { pcm, lines } = payload || {};
  if (!pcm || !Array.isArray(lines) || !lines.length) return null;
  if (_modelFailed) {
    return { lines: [], model: ALIGN_MODEL, aligned: 0, error: _modelFailedReason };
  }

  let modelBundle;
  try {
    modelBundle = await getModel();
  } catch (err) {
    return { lines: [], model: ALIGN_MODEL, aligned: 0, error: err.message || String(err) };
  }

  const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
  if (payload.sampleRate && payload.sampleRate !== SAMPLE_RATE) {
    // Caller is expected to resample to 16 kHz; if not, bail rather than misalign.
    return { lines: lines.map((l) => ({ words: l.words.map(() => null) })), model: ALIGN_MODEL, aligned: 0, error: 'expected 16kHz PCM' };
  }

  const { model, processor, vocab, blankId, separatorId } = modelBundle;
  const { alignTokens, buildTranscript } = await helpers();

  const durSec = samples.length / SAMPLE_RATE;
  const outLines = [];
  let aligned = 0;

  // Widen the per-line window on request so a word sung *before* the catalog's
  // line anchor (early entries) or held past it can still be found — the caller
  // then re-anchors the line to the real vocal onset.
  const pad =
    Number.isFinite(payload.searchPad) && payload.searchPad >= 0
      ? Math.min(payload.searchPad, 5)
      : WINDOW_PAD_SEC;

  for (const line of lines) {
    const words = line.words || [];
    const nulls = { words: words.map(() => null) };
    const s0 = Math.max(0, (line.start ?? 0) - pad);
    const e0 = Math.min(durSec, (line.end ?? durSec) + pad);
    const startSample = Math.floor(s0 * SAMPLE_RATE);
    const endSample = Math.min(samples.length, Math.ceil(e0 * SAMPLE_RATE));
    if (endSample - startSample < MIN_WINDOW_SAMPLES || !words.length) {
      outLines.push(nulls);
      continue;
    }

    const { tokens, groupWordIndices } = buildTranscript(words, vocab, { separator: '|' });
    if (!tokens.length) {
      outLines.push(nulls);
      continue;
    }

    let wordSpans = null;
    try {
      const window = samples.subarray(startSample, endSample);
      const { emission, numFrame } = await emissionFor(window, model, processor);
      if (numFrame < tokens.length) {
        outLines.push(nulls);
        continue;
      }
      const secPerFrame = (window.length / SAMPLE_RATE) / numFrame;
      const spans = alignTokens(emission, tokens, { blankId, separatorId });
      if (spans) {
        const perWord = words.map(() => null);
        spans.forEach((span, k) => {
          const origIndex = groupWordIndices[k];
          if (origIndex == null) return;
          perWord[origIndex] = {
            start: s0 + span.start * secPerFrame,
            end: s0 + span.end * secPerFrame,
            score: span.score,
          };
        });
        wordSpans = { words: perWord };
        aligned += 1;
      }
    } catch (err) {
      // One bad line shouldn't abort the whole song.
      wordSpans = null;
    }
    outLines.push(wordSpans || nulls);
  }

  return { lines: outLines, model: ALIGN_MODEL, aligned };
}

/** True once the module can at least be imported (dependency present). */
function alignAvailable() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  alignSong,
  alignAvailable,
  alignModelLoaded,
  alignModelStatus,
  setAlignModel,
  alignWarm,
  ALIGN_MODEL_PRESETS,
  WAV2VEC2_960H_VOCAB,
  WAV2VEC2_XLSR_EN_VOCAB,
  vocabForModel,
};
