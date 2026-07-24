// Vocal separation bridge — MDX-Net via onnxruntime-node in a child process.
//
// Isolates the vocal stem from a stereo mix BEFORE forced alignment. CTC phoneme
// probabilities collapse when instruments mask the voice, so aligning on the
// isolated vocal sharply improves word timing (and makes onset-snapping safe).
//
// Inference runs in `separate-worker.cjs` (plain Node via ELECTRON_RUN_AS_NODE).
// A native ORT abort used to SIGTRAP Electron's main process; the worker dying
// now soft-fails to null so the caller aligns the raw mix instead.
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
const { fork } = require('node:child_process');

const MODEL_RATE = 44100;
const DEFAULT_PARAMS = { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensation: 1.0 };
const CACHE_DIR = path.join(os.homedir(), '.cache', 'bar4bar-transformers', 'separate');
const WORKER_PATH = path.join(__dirname, 'separate-worker.cjs');

let _worker = null;
let _workerReady = null;
let _nextId = 1;
let _pending = new Map();
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

function rejectAllPending(err) {
  for (const [, { reject }] of _pending) reject(err);
  _pending.clear();
}

function markWorkerDead(reason) {
  _worker = null;
  _workerReady = null;
  _failed = true;
  _failedReason = reason;
  rejectAllPending(new Error(reason));
}

function ensureWorker() {
  if (_failed) return Promise.reject(new Error(_failedReason || 'separation unavailable'));
  if (_workerReady) return _workerReady;

  _workerReady = new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(WORKER_PATH, [], {
      // Critical: run as plain Node so we don't spawn another Electron, and so a
      // native ORT crash stays inside this child.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // Preserve Float32Array payloads (JSON serialization turns them into {}).
      serialization: 'advanced',
    });
    _worker = child;

    const onReady = (msg) => {
      if (msg && msg.cmd === 'ready' && !settled) {
        settled = true;
        child.off('message', onReady);
        resolve(child);
      }
    };
    child.on('message', onReady);
    child.on('message', (msg) => {
      if (!msg || typeof msg.id !== 'number') return;
      const pending = _pending.get(msg.id);
      if (!pending) return;
      _pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.error || 'separation worker error'));
    });
    child.on('exit', (code, signal) => {
      if (_worker !== child) return;
      const reason = signal
        ? `separation worker aborted (${signal})`
        : `separation worker exited (${code})`;
      // Unexpected death during/after work — disable for this session so we don't
      // crash-loop. A clean exit after the parent killed it also lands here.
      if (!settled) {
        settled = true;
        reject(new Error(reason));
      }
      markWorkerDead(reason);
    });
    child.on('error', (err) => {
      if (_worker !== child) return;
      if (!settled) {
        settled = true;
        reject(err);
      }
      markWorkerDead(err.message || String(err));
    });
    child.stderr?.on('data', (buf) => {
      const line = String(buf).trim();
      if (line) console.warn('[separate-worker]', line);
    });
  });

  return _workerReady;
}

function callWorker(cmd, payload) {
  return ensureWorker().then(
    (child) =>
      new Promise((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, {
          resolve: (msg) => resolve(msg),
          reject,
        });
        try {
          child.send({ id, cmd, payload });
        } catch (err) {
          _pending.delete(id);
          reject(err);
        }
      })
  );
}

/** Kick off model download/load in the background. Returns true on success. */
async function separateWarm() {
  if (!separateAvailable()) return false;
  try {
    await callWorker('warm');
    return true;
  } catch {
    return false;
  }
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

  try {
    const toF32 = (b) => {
      if (b instanceof Float32Array) return b;
      if (b instanceof ArrayBuffer) return new Float32Array(b);
      if (ArrayBuffer.isView(b)) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      return new Float32Array(b);
    };
    const left = toF32(payload.left);
    const right = payload.right ? toF32(payload.right) : undefined;
    const msg = await callWorker('run', {
      left,
      right,
      sampleRate: payload.sampleRate || MODEL_RATE,
    });
    const result = msg.result;
    if (!result?.left) return null;
    return {
      left: result.left instanceof Float32Array ? result.left : new Float32Array(result.left),
      right: result.right instanceof Float32Array ? result.right : new Float32Array(result.right),
      sampleRate: result.sampleRate || MODEL_RATE,
    };
  } catch (err) {
    if (throwOnError) throw err;
    return null;
  }
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
    worker: !!_worker,
  };
}

module.exports = { separateVocals, separateAvailable, separateReady, separateWarm, separateStatus, MODEL_RATE };
