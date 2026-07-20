// Vocal separation (Electron main process) — MDX-Net via onnxruntime-node.
//
// Isolates the vocal stem from a stereo mix BEFORE forced alignment. CTC phoneme
// probabilities collapse when instruments mask the voice, so aligning on the
// isolated vocal sharply improves word timing (and makes onset-snapping safe).
//
// The transform math lives in ../lib/stft.mjs and ../lib/mdx.mjs (pure + unit-
// tested). This file owns the model: load/cache/warm, chunked inference with
// overlap-add, and a soft-fail contract — every failure returns null so the
// caller falls back to aligning the raw mix (nothing regresses).
//
// Config (env, since MDX models differ):
//   SEPARATE_MODEL_PATH  local .onnx path (takes precedence)
//   SEPARATE_MODEL_URL   downloaded once into the cache dir if no local path
//   SEPARATE_MODEL_PARAMS JSON {nFft,hop,dimF,dimT,compensation} overriding defaults
// Left OFF until a real model is validated in the desktop app (see
// docs/alignment-accuracy-roadmap.md) — separateAvailable() is false with no model.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// lib/mdx.mjs is ESM; Electron's Node can't require() it, so import lazily
// (mirrors align.cjs). Pure transform math (STFT/iSTFT + tensor packing).
let _mdxP = null;
function mdx() {
  if (!_mdxP) _mdxP = import('../lib/mdx.mjs');
  return _mdxP;
}

const MODEL_RATE = 44100;
// Defaults for a typical MDX-Net vocal model (e.g. UVR MDX-NET / Kim Vocal).
// dimT is the frame count per chunk; chunk length = (dimT-1)*hop samples.
const DEFAULT_PARAMS = { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensation: 1.0 };
const OVERLAP = 0.25; // fraction of a chunk shared with the next, cross-faded

const CACHE_DIR = path.join(os.homedir(), '.cache', 'bar4bar-transformers', 'separate');

let _ort = null;
let _sessionP = null;
let _failed = false;
let _failedReason = null;

function params() {
  let p = { ...DEFAULT_PARAMS };
  if (process.env.SEPARATE_MODEL_PARAMS) {
    try {
      p = { ...p, ...JSON.parse(process.env.SEPARATE_MODEL_PARAMS) };
    } catch {
      /* keep defaults */
    }
  }
  return p;
}

function localModelPath() {
  if (process.env.SEPARATE_MODEL_PATH && fs.existsSync(process.env.SEPARATE_MODEL_PATH)) {
    return process.env.SEPARATE_MODEL_PATH;
  }
  if (process.env.SEPARATE_MODEL_URL) {
    const name = path.basename(new URL(process.env.SEPARATE_MODEL_URL).pathname) || 'mdx.onnx';
    const dest = path.join(CACHE_DIR, name);
    if (fs.existsSync(dest)) return dest;
  }
  return null;
}

function onnxInstalled() {
  try {
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

/**
 * True when separation can run: onnxruntime-node is installed AND a model will
 * resolve — either present on disk now (`localModelPath()`) or a URL we can
 * download on first use. A `SEPARATE_MODEL_PATH` pointing at a missing file with
 * no URL is NOT available (previously reported available, then threw at use).
 */
function separateAvailable() {
  if (_failed) return false;
  if (!onnxInstalled()) return false;
  return !!localModelPath() || !!process.env.SEPARATE_MODEL_URL;
}

/**
 * True when the model is on disk right now (no download needed before first use).
 * Lets the UI distinguish "ready" from "will download on first use".
 */
function separateReady() {
  if (_failed || !onnxInstalled()) return false;
  return !!localModelPath();
}

async function ort() {
  if (!_ort) _ort = require('onnxruntime-node');
  return _ort;
}

async function downloadIfNeeded() {
  const local =
    process.env.SEPARATE_MODEL_PATH && fs.existsSync(process.env.SEPARATE_MODEL_PATH)
      ? process.env.SEPARATE_MODEL_PATH
      : null;
  if (local) return local;
  if (!process.env.SEPARATE_MODEL_URL) throw new Error('no separation model configured');
  const url = process.env.SEPARATE_MODEL_URL;
  const name = path.basename(new URL(url).pathname) || 'mdx.onnx';
  const dest = path.join(CACHE_DIR, name);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

async function getSession() {
  if (_failed) throw new Error(_failedReason || 'separation unavailable');
  if (_sessionP) return _sessionP;
  _sessionP = (async () => {
    const rt = await ort();
    const modelPath = await downloadIfNeeded();
    const session = await rt.InferenceSession.create(modelPath);
    return { session, inputName: session.inputNames[0], outputName: session.outputNames[0] };
  })().catch((e) => {
    _sessionP = null;
    _failed = true;
    _failedReason = e.message || String(e);
    throw e;
  });
  return _sessionP;
}

/** Kick off model download/load in the background. Returns true on success. */
async function separateWarm() {
  if (!separateAvailable()) return false;
  try {
    await getSession();
    return true;
  } catch {
    return false;
  }
}

/** Linear resample a planar channel to MODEL_RATE. */
function resample(chan, fromRate) {
  if (fromRate === MODEL_RATE) return Float64Array.from(chan);
  const ratio = fromRate / MODEL_RATE;
  const outLen = Math.max(1, Math.floor(chan.length / ratio));
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const f = pos - j;
    const a = chan[j] ?? 0;
    const b = chan[j + 1] ?? a;
    out[i] = a + f * (b - a);
  }
  return out;
}

/**
 * Separate the vocal stem from a stereo mix.
 * @param {{ left: ArrayBuffer|Float32Array, right?: ArrayBuffer|Float32Array,
 *           sampleRate?: number }} payload
 * @returns {Promise<{ left: Float32Array, right: Float32Array, sampleRate: number }|null>}
 *   null on any failure (caller aligns the raw mix instead).
 */
async function separateVocals(payload, { throwOnError = false } = {}) {
  if (!payload?.left) return null;
  if (!separateAvailable()) {
    if (throwOnError) throw new Error('separation unavailable (no SEPARATE_MODEL_PATH/URL)');
    return null;
  }

  let bundle;
  try {
    bundle = await getSession();
  } catch (err) {
    if (throwOnError) throw err;
    return null;
  }

  const rt = await ort();
  const { mixToNet, netToMix, mdxChunkSamples } = await mdx();
  const p = params();
  const chunk = mdxChunkSamples(p);
  const hopSamples = Math.max(1, Math.round(chunk * (1 - OVERLAP)));
  const sr = payload.sampleRate || MODEL_RATE;

  const toF64 = (b) => (b instanceof Float32Array ? b : new Float32Array(b));
  const L = resample(toF64(payload.left), sr);
  const R = payload.right ? resample(toF64(payload.right), sr) : L;
  const total = Math.max(L.length, R.length);

  const outL = new Float64Array(total);
  const outR = new Float64Array(total);
  const norm = new Float64Array(total);
  // Triangular cross-fade weight across a chunk (tapers the overlapped seams).
  const fade = new Float64Array(chunk);
  for (let i = 0; i < chunk; i++) fade[i] = 1 - Math.abs((2 * i) / (chunk - 1) - 1);

  try {
    for (let start = 0; start < total; start += hopSamples) {
      const segL = new Float64Array(chunk);
      const segR = new Float64Array(chunk);
      for (let i = 0; i < chunk; i++) {
        segL[i] = L[start + i] ?? 0;
        segR[i] = R[start + i] ?? 0;
      }
      const input = mixToNet([segL, segR], p);
      const tensor = new rt.Tensor('float32', input, [1, 4, p.dimF, p.dimT]);
      const result = await bundle.session.run({ [bundle.inputName]: tensor });
      const out = result[bundle.outputName].data; // Float32Array [1,4,dimF,dimT]
      const [vl, vr] = netToMix(out, { ...p, length: chunk });
      const comp = p.compensation || 1;
      for (let i = 0; i < chunk && start + i < total; i++) {
        outL[start + i] += vl[i] * comp * fade[i];
        outR[start + i] += vr[i] * comp * fade[i];
        norm[start + i] += fade[i];
      }
      if (start + chunk >= total) break;
    }
  } catch (e) {
    if (throwOnError) throw e;
    return null; // any inference failure → fall back to the raw mix
  }

  for (let i = 0; i < total; i++) {
    const w = norm[i] > 1e-6 ? norm[i] : 1;
    outL[i] /= w;
    outR[i] /= w;
  }
  return { left: Float32Array.from(outL), right: Float32Array.from(outR), sampleRate: MODEL_RATE };
}

/** Diagnostic status (used by the validation script to surface load failures). */
function separateStatus() {
  return {
    available: separateAvailable(),
    ready: separateReady(),
    modelPath: localModelPath(),
    failed: _failed,
    reason: _failedReason,
    params: params(),
  };
}

module.exports = { separateVocals, separateAvailable, separateReady, separateWarm, separateStatus, MODEL_RATE };
