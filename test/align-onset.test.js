import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOnset } from '../app/align.js';

test('estimateOnset finds the first sustained energy rise', () => {
  const rate = 1000;
  const samples = new Float32Array(2000);
  for (let i = 720; i < samples.length; i++) {
    samples[i] = 0.08 * Math.sin(i / 6);
  }
  const onset = estimateOnset(samples, rate);
  assert.ok(onset, 'expected an onset');
  assert.ok(onset.time > 0.68 && onset.time < 0.8, `onset ${onset.time}`);
  assert.ok(onset.score >= 0.45);
});

test('estimateOnset rejects silence', () => {
  assert.equal(estimateOnset(new Float32Array(2000), 1000), null);
});
