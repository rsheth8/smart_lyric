// Child-process worker for MDX vocal separation (onnxruntime-node).
//
// Runs outside Electron's main process so a native ORT abort (SIGTRAP/SIGSEGV)
// cannot take down the app — the parent soft-fails and the caller keeps estimated
// word timing (raw-mix CTC is worse than the syllable estimate).
// Launched with ELECTRON_RUN_AS_NODE=1 (plain Node, not another Electron).
// Parent injects the resolved SEPARATE_MODEL_URL (default or empty) into env.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODEL_RATE = 44100;
const DEFAULT_PARAMS = { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensation: 1.0 };
const OVERLAP = 0.25;
const CACHE_DIR = path.join(os.homedir(), '.cache', 'bar4bar-transformers', 'separate');

let _ort = null;
let _session = null;
let _inputName = null;
let _outputName = null;
let _mdxP = null;

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

function mdx() {
  if (!_mdxP) _mdxP = import('../lib/mdx.mjs');
  return _mdxP;
}

async function downloadIfNeeded() {
  if (process.env.SEPARATE_MODEL_PATH && fs.existsSync(process.env.SEPARATE_MODEL_PATH)) {
    return process.env.SEPARATE_MODEL_PATH;
  }
  if (!process.env.SEPARATE_MODEL_URL) throw new Error('no separation model configured');
  const url = process.env.SEPARATE_MODEL_URL;
  const name = path.basename(new URL(url).pathname) || 'mdx.onnx';
  const dest = path.join(CACHE_DIR, name);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function getSession() {
  if (_session) return;
  _ort = require('onnxruntime-node');
  const modelPath = await downloadIfNeeded();
  // Prefer a lean CPU session — the Electron crash we hit was BFCArena::Extend
  // during Conv; disabling the arena avoids that allocator path.
  _session = await _ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  _inputName = _session.inputNames[0];
  _outputName = _session.outputNames[0];
}

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

function toF32(b) {
  if (b instanceof Float32Array) return b;
  if (b instanceof ArrayBuffer) return new Float32Array(b);
  if (ArrayBuffer.isView(b)) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return new Float32Array(b);
}

async function runSeparate(payload) {
  await getSession();
  const { mixToNet, netToMix, mdxChunkSamples } = await mdx();
  const p = params();
  const chunk = mdxChunkSamples(p);
  const hopSamples = Math.max(1, Math.round(chunk * (1 - OVERLAP)));
  const sr = payload.sampleRate || MODEL_RATE;

  const L = resample(toF32(payload.left), sr);
  const R = payload.right ? resample(toF32(payload.right), sr) : L;
  const total = Math.max(L.length, R.length);

  const outL = new Float64Array(total);
  const outR = new Float64Array(total);
  const norm = new Float64Array(total);
  const fade = new Float64Array(chunk);
  for (let i = 0; i < chunk; i++) fade[i] = 1 - Math.abs((2 * i) / (chunk - 1) - 1);

  for (let start = 0; start < total; start += hopSamples) {
    const segL = new Float64Array(chunk);
    const segR = new Float64Array(chunk);
    for (let i = 0; i < chunk; i++) {
      segL[i] = L[start + i] ?? 0;
      segR[i] = R[start + i] ?? 0;
    }
    const input = mixToNet([segL, segR], p);
    const tensor = new _ort.Tensor('float32', input, [1, 4, p.dimF, p.dimT]);
    const result = await _session.run({ [_inputName]: tensor });
    const out = result[_outputName].data;
    const [vl, vr] = netToMix(out, { ...p, length: chunk });
    const comp = p.compensation || 1;
    for (let i = 0; i < chunk && start + i < total; i++) {
      outL[start + i] += vl[i] * comp * fade[i];
      outR[start + i] += vr[i] * comp * fade[i];
      norm[start + i] += fade[i];
    }
    if (start + chunk >= total) break;
  }

  for (let i = 0; i < total; i++) {
    const w = norm[i] > 1e-6 ? norm[i] : 1;
    outL[i] /= w;
    outR[i] /= w;
  }
  return {
    left: Float32Array.from(outL),
    right: Float32Array.from(outR),
    sampleRate: MODEL_RATE,
  };
}

function reply(msg) {
  if (typeof process.send === 'function') process.send(msg);
}

process.on('message', async (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  try {
    if (msg.cmd === 'warm') {
      await getSession();
      reply({ id: msg.id, ok: true });
      return;
    }
    if (msg.cmd === 'run') {
      const result = await runSeparate(msg.payload || {});
      reply({ id: msg.id, ok: true, result });
      return;
    }
    reply({ id: msg.id, ok: false, error: `unknown cmd: ${msg.cmd}` });
  } catch (e) {
    reply({ id: msg.id, ok: false, error: e?.message || String(e) });
  }
});

reply({ cmd: 'ready' });
