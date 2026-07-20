import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { separateAvailable, separateReady, separateStatus } = require('../electron/separate.cjs');

// These tests assume onnxruntime-node is installed (it is, as a transitive dep of
// @huggingface/transformers). separateAvailable/Ready read process.env + fs live.
function withEnv(env, fn) {
  const saved = {};
  for (const k of ['SEPARATE_MODEL_PATH', 'SEPARATE_MODEL_URL']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('unavailable with no model configured', () => {
  withEnv({ SEPARATE_MODEL_PATH: undefined, SEPARATE_MODEL_URL: undefined }, () => {
    assert.equal(separateAvailable(), false);
    assert.equal(separateReady(), false);
  });
});

test('a PATH pointing at a missing file with no URL is NOT available (the bug fix)', () => {
  withEnv({ SEPARATE_MODEL_PATH: '/no/such/model.onnx', SEPARATE_MODEL_URL: undefined }, () => {
    assert.equal(separateAvailable(), false);
    assert.equal(separateReady(), false);
  });
});

test('a URL with no local file is available (will download) but not ready', () => {
  withEnv({ SEPARATE_MODEL_PATH: undefined, SEPARATE_MODEL_URL: 'https://example.com/m.onnx' }, () => {
    assert.equal(separateAvailable(), true);
    assert.equal(separateReady(), false);
  });
});

test('an existing local model file is available AND ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sep-'));
  const modelPath = join(dir, 'model.onnx');
  writeFileSync(modelPath, 'not-a-real-model');
  withEnv({ SEPARATE_MODEL_PATH: modelPath, SEPARATE_MODEL_URL: undefined }, () => {
    assert.equal(separateAvailable(), true);
    assert.equal(separateReady(), true);
    const st = separateStatus();
    assert.equal(st.available, true);
    assert.equal(st.ready, true);
    assert.equal(st.modelPath, modelPath);
  });
});
