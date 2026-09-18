import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  setAlignModel,
  alignModelStatus,
  ALIGN_MODEL_PRESETS,
  vocabForModel,
  WAV2VEC2_XLSR_EN_VOCAB,
} = require('../electron/align.cjs');

test('ALIGN_MODEL_PRESETS exposes default and high English models', () => {
  assert.equal(ALIGN_MODEL_PRESETS.default, 'Xenova/wav2vec2-base-960h');
  assert.equal(ALIGN_MODEL_PRESETS.high, 'Xenova/wav2vec2-large-xlsr-53-english');
});

test('setAlignModel switches preset and clears the loaded model', () => {
  const high = setAlignModel('high');
  assert.equal(high.preset, 'high');
  assert.equal(high.model, ALIGN_MODEL_PRESETS.high);
  assert.equal(high.loaded, false);

  const back = setAlignModel('default');
  assert.equal(back.preset, 'default');
  assert.equal(back.model, ALIGN_MODEL_PRESETS.default);

  const status = alignModelStatus();
  assert.equal(status.model, ALIGN_MODEL_PRESETS.default);
});

test('setAlignModel accepts a raw HF id', () => {
  const st = setAlignModel('Xenova/wav2vec2-base-960h');
  assert.equal(st.model, 'Xenova/wav2vec2-base-960h');
  assert.equal(st.preset, 'default');
});

test('vocabForModel picks the XLSR lowercase map for the high preset', () => {
  assert.equal(vocabForModel(ALIGN_MODEL_PRESETS.high), WAV2VEC2_XLSR_EN_VOCAB);
  assert.equal(vocabForModel(ALIGN_MODEL_PRESETS.high).a, 7);
  assert.equal(vocabForModel(ALIGN_MODEL_PRESETS.default).E, 5);
});
