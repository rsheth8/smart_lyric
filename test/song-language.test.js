import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLanguagePrompt, parseLanguageReply } from '../lib/song-language.mjs';

test('buildLanguagePrompt includes metadata and instructions', () => {
  const prompt = buildLanguagePrompt({ artist: 'Sudesh Bhonsle', track: 'Jigar Da Tukda', album: 'Ladla' });
  assert.match(prompt, /Track: Jigar Da Tukda/);
  assert.match(prompt, /Artist: Sudesh Bhonsle/);
  assert.match(prompt, /Album: Ladla/);
  assert.match(prompt, /ONE lowercase English word/);
});

test('parseLanguageReply accepts known languages', () => {
  assert.equal(parseLanguageReply('hindi'), 'hindi');
  assert.equal(parseLanguageReply('Hindi'), 'hindi');
  assert.equal(parseLanguageReply('  english.\n'), 'english');
  assert.equal(parseLanguageReply('The language is likely punjabi'), null); // first word must be the language
  assert.equal(parseLanguageReply('punjabi'), 'punjabi');
});

test('parseLanguageReply maps aliases to whisper names', () => {
  assert.equal(parseLanguageReply('mandarin'), 'chinese');
  assert.equal(parseLanguageReply('cantonese'), 'chinese');
  assert.equal(parseLanguageReply('tagalog'), 'filipino');
});

test('parseLanguageReply rejects unknown or unhelpful replies', () => {
  assert.equal(parseLanguageReply('unknown'), null);
  assert.equal(parseLanguageReply(''), null);
  assert.equal(parseLanguageReply(null), null);
  assert.equal(parseLanguageReply('klingon'), null);
  assert.equal(parseLanguageReply('123'), null);
});
