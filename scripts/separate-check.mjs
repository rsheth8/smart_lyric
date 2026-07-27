// Standalone vocal-separation validation — no Electron, no UI.
//
// Separates one WAV with the configured MDX-Net model and writes the vocal stem
// to a WAV you can ear-check BEFORE wiring separation into alignment. Confirms the
// model loads, the STFT convention matches, and the stem sounds like isolated
// vocals.
//
// Usage:
//   node scripts/separate-check.mjs <input.wav> [output.wav] [model.onnx]
//
// The model may also come from env (SEPARATE_MODEL_PATH or SEPARATE_MODEL_URL);
// params default to UVR-MDX-NET-Voc_FT (n_fft 6144, dim_f 3072, dim_t 256,
// hop 1024) and can be overridden with SEPARATE_MODEL_PARAMS (JSON).
//
// Convert any audio to a WAV first, e.g.:
//   ffmpeg -i song.mp3 -ac 2 -ar 44100 song.wav

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { encodeWAV, decodeWAV, rms } from '../app/wav.js';
import { separateVocals, separateStatus, separateShutdown } from '../electron/separate.cjs';

const [, , inArg, outArg, modelArg] = process.argv;
if (!inArg) {
  console.error('usage: node scripts/separate-check.mjs <input.wav> [output.wav] [model.onnx]');
  process.exit(1);
}
if (modelArg) process.env.SEPARATE_MODEL_PATH = resolve(modelArg);
// Pin params for UVR-MDX-NET-Voc_FT unless the caller already set them.
if (!process.env.SEPARATE_MODEL_PARAMS) {
  process.env.SEPARATE_MODEL_PARAMS = JSON.stringify({
    nFft: 6144,
    hop: 1024,
    dimF: 3072,
    dimT: 256,
    compensation: 1.0,
  });
}

const inputPath = resolve(inArg);
const outputPath = resolve(outArg || inputPath.replace(/\.wav$/i, '') + '.vocals.wav');

const status = separateStatus();
console.log('Model:', status.modelPath || '(none configured)');
console.log('Params:', JSON.stringify(status.params));
if (!status.available) {
  console.error(
    '\n✗ No model configured. Pass a model path as the 3rd arg or set SEPARATE_MODEL_PATH.\n' +
      '  Download one, e.g. UVR-MDX-NET-Voc_FT.onnx:\n' +
      '  https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx'
  );
  process.exit(1);
}

let wav;
try {
  wav = decodeWAV(readFileSync(inputPath).buffer);
} catch (e) {
  console.error(`✗ Could not read WAV: ${e.message}. Convert with: ffmpeg -i in.mp3 -ac 2 -ar 44100 in.wav`);
  process.exit(1);
}
const left = wav.channels[0];
const right = wav.channels[1] || wav.channels[0];
const durSec = left.length / wav.sampleRate;
console.log(`Input: ${basename(inputPath)}  ${wav.numChannels}ch @ ${wav.sampleRate}Hz  ${durSec.toFixed(1)}s  rms=${rms(left).toFixed(4)}`);

console.log('Separating… (first run downloads/loads the model)');
const t0 = Date.now();
let stem;
try {
  stem = await separateVocals({ left, right, sampleRate: wav.sampleRate }, { throwOnError: true });
} catch (e) {
  console.error(`\n✗ Separation failed: ${e.message}`);
  console.error('  If it is a shape/dimension error, the model needs different SEPARATE_MODEL_PARAMS');
  console.error('  (n_fft / dim_f / dim_t) — check the model card and set them, then retry.');
  process.exit(1);
}
if (!stem?.left) {
  console.error('✗ Separation returned no audio.');
  process.exit(1);
}

// Downmix the stem to mono for a simple ear-check.
const n = stem.left.length;
const mono = new Float32Array(n);
for (let i = 0; i < n; i++) mono[i] = 0.5 * (stem.left[i] + (stem.right[i] ?? stem.left[i]));
writeFileSync(outputPath, Buffer.from(encodeWAV(mono, stem.sampleRate)));

// The separation worker is a fork; it holds this process's event loop open.
separateShutdown();

const elapsed = (Date.now() - t0) / 1000;
console.log(`\n✓ Done in ${elapsed.toFixed(1)}s  (${(durSec / elapsed).toFixed(1)}× realtime)`);
console.log(`  Stem rms=${rms(mono).toFixed(4)}  →  ${outputPath}`);
console.log('  Ear-check: it should sound like isolated vocals (instruments largely gone).');
