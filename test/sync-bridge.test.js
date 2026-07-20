import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTimeline } from '../app/sync-bridge.js';

test('serializeTimeline carries confidence fields for the overlay', () => {
  const lines = [
    {
      start: 1,
      end: 3,
      uncertain: true,
      words: [
        { text: 'hi', start: 1, end: 1.5, score: 0.1 },
        { text: 'there', start: 1.5, end: 3, score: 0.9 },
      ],
    },
  ];
  const out = serializeTimeline(lines);
  assert.equal(out[0].uncertain, true);
  assert.equal(out[0].words[0].score, 0.1);
  assert.equal(out[0].words[1].score, 0.9);
  // Still carries the timing fields.
  assert.equal(out[0].words[0].text, 'hi');
  assert.equal(out[0].start, 1);
  assert.equal(out[0].end, 3);
});

test('serializeTimeline tolerates missing confidence (line-level source)', () => {
  const out = serializeTimeline([
    { start: 0, end: 2, words: [{ text: 'a', start: 0, end: 2 }] },
  ]);
  assert.equal(out[0].uncertain, undefined);
  assert.equal(out[0].words[0].score, undefined);
});

test('serializeTimeline handles empty input', () => {
  assert.deepEqual(serializeTimeline(null), []);
  assert.deepEqual(serializeTimeline([]), []);
});
