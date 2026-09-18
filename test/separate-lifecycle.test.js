// Contract tests for the separation module's failure and lifecycle behaviour.
//
// Soft-fail returns null so callers keep estimated word timing (raw-mix CTC is
// refused). Anything that returns a never-settling promise turns graceful
// degradation into a hang that stops alignment entirely. These run with the
// baked-in default URL disabled — the explicit opt-out path.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const separate = require('../electron/separate.cjs');

const PCM = { left: new Float32Array(1024), right: new Float32Array(1024), sampleRate: 44100 };

let savedPath;
let savedUrl;

function disableDefaultModel() {
  savedPath = process.env.SEPARATE_MODEL_PATH;
  savedUrl = process.env.SEPARATE_MODEL_URL;
  delete process.env.SEPARATE_MODEL_PATH;
  process.env.SEPARATE_MODEL_URL = '';
}

function restoreEnv() {
  if (savedPath === undefined) delete process.env.SEPARATE_MODEL_PATH;
  else process.env.SEPARATE_MODEL_PATH = savedPath;
  if (savedUrl === undefined) delete process.env.SEPARATE_MODEL_URL;
  else process.env.SEPARATE_MODEL_URL = savedUrl;
}

before(() => disableDefaultModel());
after(() => restoreEnv());

describe('separation module surface', () => {
  test('exports the lifecycle helpers callers depend on', () => {
    for (const name of [
      'separateVocals',
      'separateAvailable',
      'separateReady',
      'separateWarm',
      'separateStatus',
      'separateShutdown',
    ]) {
      assert.equal(typeof separate[name], 'function', `${name} is exported`);
    }
  });

  test('reports unavailable when URL is explicitly disabled', () => {
    assert.equal(separate.separateAvailable(), false);
    assert.equal(separate.separateReady(), false);
  });

  test('separateStatus describes why it is unavailable when disabled', () => {
    const s = separate.separateStatus();
    assert.equal(s.available, false);
    assert.equal(s.ready, false);
    assert.equal(s.worker, false, 'no worker forked before first use');
    assert.ok('modelPath' in s && 'params' in s);
  });
});

describe('soft-fail contract', () => {
  test('returns null rather than hanging when unavailable', async () => {
    assert.equal(await separate.separateVocals(PCM), null);
  });

  test('returns null for an empty payload', async () => {
    assert.equal(await separate.separateVocals({}), null);
    assert.equal(await separate.separateVocals(null), null);
  });

  test('throwOnError surfaces the reason for diagnostics', async () => {
    await assert.rejects(
      () => separate.separateVocals(PCM, { throwOnError: true }),
      /separation unavailable/
    );
  });

  test('warm resolves false instead of rejecting', async () => {
    assert.equal(await separate.separateWarm(), false);
  });
});

describe('separateShutdown', () => {
  test('is safe with no worker running, and repeatable', () => {
    // The CLI diagnostics call this unconditionally; it must never throw.
    assert.doesNotThrow(() => separate.separateShutdown());
    assert.doesNotThrow(() => separate.separateShutdown());
    assert.equal(separate.separateStatus().worker, false);
  });

  test('leaves the module usable rather than permanently failed', async () => {
    separate.separateShutdown();
    // Shutdown is not a crash: it must not latch `_failed` the way a worker
    // death does, or a host that stops and restarts separation stays broken.
    assert.equal(separate.separateStatus().failed, false);
    assert.equal(await separate.separateVocals(PCM), null);
  });
});
