import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charToId, buildTranscript } from '../lib/align-text.mjs';

// A tiny wav2vec2-like vocab: '|' separator, uppercase letters, apostrophe.
const VOCAB = { '<pad>': 0, '|': 1, A: 2, B: 3, C: 4, D: 5, E: 6, T: 7, "'": 8 };

test('charToId is case-insensitive against an uppercase vocab', () => {
  assert.equal(charToId(VOCAB, 'a'), 2);
  assert.equal(charToId(VOCAB, 'A'), 2);
  assert.equal(charToId(VOCAB, '|'), 1);
  assert.equal(charToId(VOCAB, '?'), null); // not in vocab
});

test('buildTranscript encloses words with separators and maps groups', () => {
  const { tokens, groupWordIndices, separatorId } = buildTranscript(['ab', 'cd'], VOCAB);
  assert.equal(separatorId, 1);
  // |AB|CD|  → [1,2,3,1,4,5,1]
  assert.deepEqual(tokens, [1, 2, 3, 1, 4, 5, 1]);
  assert.deepEqual(groupWordIndices, [0, 1]);
});

test('buildTranscript skips words with no in-vocab characters', () => {
  const { tokens, groupWordIndices } = buildTranscript(['ab', '???', 'cd'], VOCAB);
  // The middle word contributes nothing, so only indices 0 and 2 get groups.
  assert.deepEqual(groupWordIndices, [0, 2]);
  assert.deepEqual(tokens, [1, 2, 3, 1, 4, 5, 1]);
});

test('buildTranscript drops punctuation inside a word but keeps known symbols', () => {
  const { tokens } = buildTranscript(["a'b?"], VOCAB);
  // a ' b  → the '?' is dropped
  assert.deepEqual(tokens, [1, 2, 8, 3, 1]);
});

test('buildTranscript returns empty when nothing aligns', () => {
  const { tokens, groupWordIndices } = buildTranscript(['???', '...'], VOCAB);
  assert.deepEqual(tokens, []);
  assert.deepEqual(groupWordIndices, []);
});
