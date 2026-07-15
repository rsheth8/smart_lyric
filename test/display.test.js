import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerTranslate } from '../app/display.js';

// display.js imports no browser globals at module scope, so the pure helper
// is safe to unit-test in Node.

test('centers a line by translating its midpoint to the viewport middle', () => {
  // A line 80px tall whose top sits at 1000px, in an 800px-tall viewport.
  // Its center is at 1040 → to reach 400 we must translate up by 640.
  assert.equal(centerTranslate(800, 1000, 80), -640);
});

test('the first line (top ~0) is pushed down to the middle', () => {
  assert.equal(centerTranslate(800, 0, 80), 360);
});

test('a line already centered needs no translation', () => {
  // center at 400 in an 800 viewport → translate 0.
  assert.equal(centerTranslate(800, 360, 80), 0);
});

test('returns an integer (avoids sub-pixel jitter)', () => {
  assert.equal(centerTranslate(801, 101, 33), Math.round(801 / 2 - (101 + 33 / 2)));
  assert.ok(Number.isInteger(centerTranslate(801, 101, 33)));
});
