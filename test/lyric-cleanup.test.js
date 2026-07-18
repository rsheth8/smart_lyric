import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCleanupPrompt,
  parseCleanupReply,
  cleanedLinesLookSane,
} from '../lib/lyric-cleanup.mjs';
import { chunksToTimeline, applyCleanedLineTexts } from '../app/providers/formats/asr-timeline.js';

test('buildCleanupPrompt numbers every line and pins the count', () => {
  const prompt = buildCleanupPrompt({
    lines: ['first line', 'second line'],
    artist: 'Artist',
    track: 'Song',
  });
  assert.ok(prompt.includes('1. first line'));
  assert.ok(prompt.includes('2. second line'));
  assert.ok(prompt.includes('EXACTLY 2 lines'));
  assert.ok(prompt.includes('"Song" by Artist'));
});

test('parseCleanupReply reads numbered lines back in order', () => {
  const reply = '1. First line fixed\n2. Second line fixed';
  assert.deepEqual(parseCleanupReply(reply, 2), ['First line fixed', 'Second line fixed']);
});

test('parseCleanupReply tolerates unnumbered replies with a matching count', () => {
  const reply = 'First\nSecond';
  assert.deepEqual(parseCleanupReply(reply, 2), ['First', 'Second']);
});

test('parseCleanupReply rejects wrong line counts', () => {
  assert.equal(parseCleanupReply('1. only one line', 2), null);
  assert.equal(parseCleanupReply('a\nb\nc', 2), null);
  assert.equal(parseCleanupReply('', 2), null);
});

test('cleanedLinesLookSane accepts small edits and rejects rewrites', () => {
  const original = ['i got my hands up their playing my song', 'the butterflies fly away'];
  const smallFix = ['I got my hands up, they’re playing my song', 'The butterflies fly away'];
  const rewrite = ['completely different words here entirely', 'nothing shared with source text'];
  assert.equal(cleanedLinesLookSane(original, smallFix), true);
  assert.equal(cleanedLinesLookSane(original, rewrite), false);
  assert.equal(cleanedLinesLookSane(original, ['only one']), false);
});

test('applyCleanedLineTexts keeps timing but swaps words', () => {
  const tl = chunksToTimeline([
    { text: 'hello word', timestamp: [0, 2] },
    { text: 'second lyne here', timestamp: [3, 6] },
  ]);
  const ok = applyCleanedLineTexts(tl, ['hello world', 'second line here']);
  assert.equal(ok, true);
  assert.equal(tl.lines[0].start, 0);
  assert.equal(tl.lines[0].end, 2);
  assert.deepEqual(tl.lines[0].words.map((w) => w.text), ['hello', 'world']);
  assert.deepEqual(tl.lines[1].words.map((w) => w.text), ['second', 'line', 'here']);
  assert.ok(tl.lines[1].words[2].end <= 6 + 1e-9);
});

test('applyCleanedLineTexts refuses mismatched counts and keeps blanks', () => {
  const tl = chunksToTimeline([{ text: 'keep me', timestamp: [0, 1] }]);
  assert.equal(applyCleanedLineTexts(tl, ['a', 'b']), false);
  assert.equal(applyCleanedLineTexts(tl, ['']), true);
  assert.deepEqual(tl.lines[0].words.map((w) => w.text), ['keep', 'me']);
});
