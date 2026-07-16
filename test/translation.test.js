import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranslationLrc,
  attachTranslation,
  attachLineText,
} from '../app/providers/formats/translation.js';

test('attachLineText attaches an arbitrary field and sets the has-flag', () => {
  const timeline = {
    lines: [
      { start: 5, words: [{ text: '夜' }] },
      { start: 10, words: [{ text: '君' }] },
    ],
  };
  const n = attachLineText(timeline, '[00:05.00]yoru\n[00:10.00]kimi', 'roman');
  assert.equal(n, 2);
  assert.equal(timeline.lines[0].roman, 'yoru');
  assert.equal(timeline.lines[1].roman, 'kimi');
  assert.equal(timeline.hasRoman, true);
});

test('parseTranslationLrc parses timestamped lines into sorted entries', () => {
  const lrc = '[00:12.50]Hello there\n[00:05.00]First line\n[bad]ignored';
  const out = parseTranslationLrc(lrc);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, 5);
  assert.equal(out[0].text, 'First line');
  assert.equal(out[1].start, 12.5);
});

test('parseTranslationLrc skips blank / metadata-only lines', () => {
  const out = parseTranslationLrc('[00:01.00]\n[ti:Title]\n[00:02.00]Real');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Real');
});

test('attachTranslation matches by nearest start within tolerance', () => {
  const timeline = {
    lines: [
      { start: 5.1, words: [{ text: 'bonjour' }] },
      { start: 12.4, words: [{ text: 'monde' }] },
    ],
  };
  attachTranslation(timeline, '[00:05.00]hello\n[00:12.50]world');
  assert.equal(timeline.lines[0].translation, 'hello');
  assert.equal(timeline.lines[1].translation, 'world');
  assert.equal(timeline.hasTranslation, true);
});

test('attachTranslation leaves far-off lines untranslated', () => {
  const timeline = { lines: [{ start: 50, words: [{ text: 'x' }] }] };
  attachTranslation(timeline, '[00:05.00]hello', { tolerance: 3 });
  assert.equal(timeline.lines[0].translation, undefined);
  assert.equal(timeline.hasTranslation, false);
});

test('attachTranslation skips a translation identical to the original', () => {
  const timeline = { lines: [{ start: 5, words: [{ text: 'la' }, { text: 'la' }] }] };
  attachTranslation(timeline, '[00:05.00]la la');
  assert.equal(timeline.lines[0].translation, undefined);
  assert.equal(timeline.hasTranslation, false);
});
