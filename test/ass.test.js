import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseASS, parseKaraokeWords } from '../app/providers/formats/ass.js';

test('{\\k100}hello world splits one second across both tokens — no leftover brace', () => {
  const words = parseKaraokeWords('{\\k100}hello world', 0, 1);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'hello');
  assert.equal(words[1].text, 'world');
  assert.ok(!words[0].text.includes('}'), 'closing brace must not leak into text');
  // Combined duration is the \k chunk (1.0s), not 1.0s per token.
  assert.ok(Math.abs(words[1].end - words[0].start - 1) < 1e-6, `span ${words[1].end - words[0].start}`);
  assert.equal(words[1].end, 1, 'capped at line end');
});

test('multiword \\k durations are proportional to token length', () => {
  const words = parseKaraokeWords('{\\k100}hi world', 0, 10);
  assert.equal(words.length, 2);
  const d0 = words[0].end - words[0].start;
  const d1 = words[1].end - words[1].start;
  assert.ok(d1 > d0, 'longer token gets more of the karaoke span');
  assert.ok(Math.abs(d0 + d1 - 1) < 1e-6);
});

test('parseASS dialogue keeps exact text and respects line end', () => {
  const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\k50}hello {\\k50}world
`;
  const { lines } = parseASS(ass);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    lines[0].words.map((w) => w.text),
    ['hello', 'world']
  );
  assert.equal(lines[0].start, 1);
  assert.equal(lines[0].end, 2);
  assert.ok(lines[0].words[0].start >= 1);
  assert.ok(lines[0].words[1].end <= 2);
});
