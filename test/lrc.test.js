import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC } from '../app/lrc.js';

const SAMPLE = `[ti:Demo]
[00:01.00]First line here
[00:03.50]Second line goes on
[00:07.00]Third`;

test('parses timed lines in order with correct start times', () => {
  const { lines } = parseLRC(SAMPLE);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].start, 1);
  assert.equal(lines[1].start, 3.5);
  assert.equal(lines[2].start, 7);
  assert.deepEqual(lines[0].words.map((w) => w.text), ['First', 'line', 'here']);
});

test('a line ends where the next begins', () => {
  const { lines } = parseLRC(SAMPLE);
  assert.equal(lines[0].end, 3.5);
  assert.equal(lines[1].end, 7);
});

test('last line uses the trailing fallback duration', () => {
  const { lines } = parseLRC(SAMPLE, { trailingLineSeconds: 4 });
  assert.equal(lines[2].end, 11);
});

test('interpolated word timings are monotonic and cover the line span', () => {
  const { lines } = parseLRC(SAMPLE);
  const w = lines[0].words;
  assert.equal(w[0].start, 1); // first word starts at line start
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i].start >= w[i - 1].end - 1e-9, 'words are ordered');
  }
  assert.ok(Math.abs(w[w.length - 1].end - lines[0].end) < 1e-6, 'last word ends at line end');
});

test('uses true per-word timing when enhanced LRC is present', () => {
  const enhanced = `[00:10.00]<00:10.00>Hey <00:10.80>there <00:11.90>friend`;
  const { lines } = parseLRC(enhanced);
  const w = lines[0].words;
  assert.deepEqual(w.map((x) => x.text), ['Hey', 'there', 'friend']);
  assert.equal(w[0].start, 10);
  assert.equal(w[1].start, 10.8);
  assert.equal(w[2].start, 11.9);
});

test('a line with repeated timestamps expands to multiple lines', () => {
  const chorus = `[00:20.00][01:05.00]Repeated chorus`;
  const { lines } = parseLRC(chorus);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].start, 20);
  assert.equal(lines[1].start, 65);
});

test('ignores metadata and untimed/blank lines', () => {
  const messy = `[ar:Someone]\n\n[00:02.00]Only real line\ngarbage without stamp`;
  const { lines } = parseLRC(messy);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words[0].text, 'Only');
});

test('empty input yields no lines', () => {
  assert.deepEqual(parseLRC('').lines, []);
});

test('parses millisecond precision timestamps', () => {
  const { lines } = parseLRC('[00:12.345]Precise');
  assert.equal(lines[0].start, 12.345);
});
