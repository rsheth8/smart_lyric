import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, wrapWords } from '../app/clip.js';

test('pickMimeType prefers MP4, falls back to WebM, and admits defeat', () => {
  assert.equal(pickMimeType(() => true), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(pickMimeType((t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMimeType(() => false), '');
});

test('wrapWords fills rows greedily without overflowing', () => {
  const measure = (s) => s.length * 10; // space = 10
  const words = ['one', 'two', 'three', 'four'].map((text) => ({ text }));
  const rows = wrapWords(words, measure, 80).map((r) => r.map((w) => w.text).join(' '));
  assert.deepEqual(rows, ['one two', 'three', 'four']);
  // A word wider than the row still gets a row of its own rather than vanishing.
  assert.deepEqual(wrapWords([{ text: 'supercalifragilistic' }], measure, 50).length, 1);
  assert.deepEqual(wrapWords([], measure, 80), []);
});
