// Speech-to-text fallback for songs with no catalog/plain lyrics.
//
// The renderer decodes browser-supported audio to 16 kHz mono PCM, then this
// main-process helper runs a cached Transformers.js ASR model. Plain text or
// timestamped chunks are returned; the renderer builds the lyric timeline.

const os = require('node:os');
const path = require('node:path');

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'Xenova/whisper-tiny';
const EXPECTED_SAMPLE_RATE = 16000;

let _tf = null;
let _pipelineP = null;
let _modelFailed = false;
let _modelFailedReason = null;

async function tf() {
  if (!_tf) {
    _tf = await import('@huggingface/transformers');
    _tf.env.cacheDir = path.join(os.homedir(), '.cache', 'bar4bar-transformers');
    _tf.env.allowLocalModels = false;
  }
  return _tf;
}

async function getPipeline() {
  if (_modelFailed) throw new Error(_modelFailedReason || 'transcribe model unavailable');
  if (_pipelineP) return _pipelineP;
  _pipelineP = (async () => {
    console.log(`[transcribe] loading model ${TRANSCRIBE_MODEL}…`);
    const { pipeline } = await tf();
    const asr = await pipeline('automatic-speech-recognition', TRANSCRIBE_MODEL, {
      progress_callback: (p) => {
        if (p?.status) console.log(`[transcribe] ${p.status}`, p.file || p.progress || '');
      },
    });
    console.log('[transcribe] model ready');
    return asr;
  })().catch((e) => {
    _pipelineP = null;
    _modelFailed = true;
    _modelFailedReason = e.message || String(e);
    console.warn('[transcribe] model load failed:', _modelFailedReason);
    throw e;
  });
  return _pipelineP;
}

function normalizeAsrText(result) {
  if (typeof result === 'string') return result.trim();
  if (typeof result?.text === 'string') return result.text.trim();
  if (Array.isArray(result?.chunks)) {
    return result.chunks.map((c) => c?.text || '').join(' ').trim();
  }
  return '';
}

function normalizeChunks(result) {
  if (!Array.isArray(result?.chunks)) return [];
  return result.chunks
    .map((c) => ({
      text: String(c?.text || '').trim(),
      timestamp: Array.isArray(c?.timestamp) ? c.timestamp : null,
    }))
    .filter((c) => c.text);
}

/** Coerce IPC / view payloads into a contiguous Float32Array Whisper can chunk. */
function toFloat32Pcm(pcm) {
  if (pcm instanceof Float32Array) return pcm.slice();
  if (pcm instanceof ArrayBuffer) return new Float32Array(pcm);
  if (ArrayBuffer.isView(pcm)) {
    return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  }
  return new Float32Array(pcm);
}

async function transcribeAudio(payload = {}) {
  const sampleRate = payload.sampleRate || EXPECTED_SAMPLE_RATE;
  if (sampleRate !== EXPECTED_SAMPLE_RATE) {
    return { text: '', chunks: [], error: `Expected ${EXPECTED_SAMPLE_RATE} Hz PCM, got ${sampleRate} Hz.` };
  }
  if (!payload.pcm) return { text: '', chunks: [], error: 'No audio samples supplied.' };

  try {
    // The ASR pipeline expects a raw Float32Array (NOT `{ array, sampling_rate }`).
    // Passing an object makes chunking call `aud.subarray(...)` and throw.
    const samples = toFloat32Pcm(payload.pcm);
    if (!samples.length) return { text: '', chunks: [], error: 'No audio samples supplied.' };

    const seconds = samples.length / EXPECTED_SAMPLE_RATE;
    const wantTs = payload.returnTimestamps !== false;
    console.log(
      `[transcribe] running ASR on ${seconds.toFixed(1)}s of audio (language: ${payload.language || 'auto'})…`
    );
    const asr = await getPipeline();
    const options = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: wantTs ? true : false,
      task: 'transcribe',
    };
    if (payload.language) options.language = payload.language;
    const result = await asr(samples, options);
    const text = normalizeAsrText(result);
    const chunks = wantTs ? normalizeChunks(result) : [];
    console.log(`[transcribe] done (${text.length} chars, ${chunks.length} chunks)`);
    return { text, chunks, model: TRANSCRIBE_MODEL };
  } catch (e) {
    console.warn('[transcribe] failed:', e.message || e);
    return { text: '', chunks: [], error: e.message || String(e), model: TRANSCRIBE_MODEL };
  }
}

function transcribeAvailable() {
  return !_modelFailed;
}

module.exports = { transcribeAudio, transcribeAvailable };
