import test from 'node:test';
import assert from 'node:assert/strict';
import { measureTiming } from '../lib/timing-accuracy.mjs';
test('accuracy separates constant playback delay from word placement and counts missing words', () => {
  const reference = [{ text: 'one', start: 1 }, { text: 'two', start: 2 }, { text: 'three', start: 3 }];
  const result = measureTiming([{ text: 'one', start: 1.5 }, { text: 'three', start: 3.5 }], reference);
  assert.equal(result.absolute.medianMs, 500);
  assert.equal(result.afterConstantOffset.medianMs, 0);
  assert.equal(result.constantOffsetMs, 500);
  assert.equal(result.missingReferenceWords, 1);
  assert.equal(result.matchedFraction, 2 / 3);
});
