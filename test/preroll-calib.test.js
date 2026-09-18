import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstCatalogVocalSec,
  prerollSeekSec,
  latencyFromOnset,
  timingSamplesFromReanchors,
  waitForPrerollOnset,
} from '../app/preroll-calib.js';

test('firstCatalogVocalSec prefers first word start', () => {
  assert.equal(
    firstCatalogVocalSec({
      lines: [
        { start: 10, end: 14, words: [{ start: 10.2, end: 10.5 }] },
        { start: 15, end: 18, words: [{ start: 15, end: 15.3 }] },
      ],
    }),
    10.2
  );
  assert.equal(firstCatalogVocalSec({ lines: [{ start: 5, end: 8 }] }), 5);
  assert.equal(firstCatalogVocalSec({ lines: [] }), null);
});

test('prerollSeekSec pads before the vocal', () => {
  assert.equal(prerollSeekSec(12, { padSec: 2.5 }), 9.5);
  assert.equal(prerollSeekSec(1, { padSec: 2.5 }), 0);
  assert.equal(prerollSeekSec(null), null);
});

test('latencyFromOnset matches live auto-timing formula', () => {
  // Catalog says 10.0; onset heard at song-time 10.45 ⇒ expected − raw = −0.45
  const v = latencyFromOnset({
    expectedSec: 10,
    windowStartSec: 9,
    onsetTimeInWindow: 1.45,
  });
  assert.ok(Math.abs(v - -0.45) < 1e-9);
});

test('timingSamplesFromReanchors flips median delta into a latency sample', () => {
  const lines = [
    { _reanchorDelta: 0.2 },
    { _reanchorDelta: 0.22 },
    { _reanchorDelta: 0.18 },
    { _reanchorDelta: 0.01 }, // ignored (too small)
  ];
  const samples = timingSamplesFromReanchors(lines);
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].value - -0.2) < 1e-9);
  assert.equal(samples[0].source, 'reanchor');
});

test('waitForPrerollOnset returns a confident hit', async () => {
  const sr = 1000;
  // Synthetic PCM: quiet then a step (onset) at 0.5s into a 2s buffer.
  const pcm = new Float32Array(sr * 2);
  for (let i = Math.floor(0.5 * sr); i < pcm.length; i++) pcm[i] = 0.2;

  const mic = {
    sampleRate: sr,
    getOrderedPcm: () => pcm,
  };
  let songPos = 10.0; // "now" at end of buffer ⇒ windowStart = 8
  const hit = await waitForPrerollOnset({
    mic,
    expectedSec: 8.5, // onset at window 0.5 → song 8.5
    getSongPos: () => songPos,
    timeoutSec: 1,
    searchPadSec: 2,
    pollMs: 20,
    estimate: () => ({ time: 0.5, score: 0.9 }),
  });
  assert.ok(hit);
  assert.ok(Math.abs(hit.offset) < 0.05, `offset=${hit.offset}`);
});
