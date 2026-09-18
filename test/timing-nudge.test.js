import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeWord, nudgeLine, nudgeTimeline } from '../app/timing-nudge.js';

function line(start, words) {
  // words: [[text, start, end], ...]
  return {
    start,
    end: words[words.length - 1][2],
    words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
  };
}

test('nudgeWord shifts one word and keeps neighbors ordered', () => {
  const l = line(1, [
    ['a', 1.0, 1.2],
    ['b', 1.2, 1.5],
    ['c', 1.5, 1.8],
  ]);
  const res = nudgeWord(l, 1, 0.1);
  assert.ok(res);
  assert.ok(l.words[1].start > l.words[0].end);
  assert.ok(l.words[1].end < l.words[2].start);
  assert.equal(l.words[1]._humanNudged, true);
  // Neighbors untouched.
  assert.equal(l.words[0].start, 1.0);
  assert.equal(l.words[2].start, 1.5);
});

test('nudgeWord refuses to invert past the next word', () => {
  const l = line(0, [
    ['a', 0, 0.3],
    ['b', 0.3, 0.5],
  ]);
  // Huge positive nudge on word 0 would slam into word 1 — clamp, don't invert.
  const res = nudgeWord(l, 0, 5);
  assert.ok(res);
  assert.ok(l.words[0].end <= l.words[1].start - 0.01 + 1e-9);
  assert.ok(l.words[0].start < l.words[1].start);
});

test('nudgeLine shifts the whole line and clamps against neighbors', () => {
  const tl = {
    lines: [
      line(0, [['x', 0, 0.5]]),
      line(1, [
        ['a', 1.0, 1.3],
        ['b', 1.3, 1.8],
      ]),
      line(3, [['y', 3, 3.5]]),
    ],
  };
  const mid = tl.lines[1];
  const res = nudgeLine(mid, -0.2, { prevEnd: tl.lines[0].end, nextStart: tl.lines[2].start });
  assert.ok(res);
  assert.ok(Math.abs(mid.start - 0.8) < 1e-9);
  assert.ok(Math.abs(mid.words[0].start - 0.8) < 1e-9);
  assert.ok(mid.start > tl.lines[0].end);
  assert.ok(mid.end < tl.lines[2].start);
  assert.equal(mid._humanNudged, true);
});

test('nudgeTimeline word scope marks the line aligned and human-edited', () => {
  const tl = {
    lines: [
      line(0, [
        ['hello', 0, 0.4],
        ['world', 0.4, 0.9],
      ]),
    ],
  };
  const res = nudgeTimeline(tl, { scope: 'word', lineIndex: 0, wordIndex: 1, deltaSec: 0.05 });
  assert.equal(res.scope, 'word');
  assert.equal(tl.humanEdited, true);
  assert.equal(tl.lines[0]._vocalAligned, true);
  assert.ok(tl.lines[0].words[1].start > 0.4);
});

test('nudgeTimeline line scope shifts every word', () => {
  const tl = {
    lines: [
      line(1, [
        ['a', 1.0, 1.2],
        ['b', 1.2, 1.5],
      ]),
    ],
  };
  nudgeTimeline(tl, { scope: 'line', lineIndex: 0, deltaSec: 0.25 });
  assert.ok(Math.abs(tl.lines[0].start - 1.25) < 1e-9);
  assert.ok(Math.abs(tl.lines[0].words[0].start - 1.25) < 1e-9);
  assert.ok(Math.abs(tl.lines[0].words[1].start - 1.45) < 1e-9);
});

test('nudgeTimeline returns null for a bad index', () => {
  const tl = { lines: [line(0, [['a', 0, 0.5]])] };
  assert.equal(nudgeTimeline(tl, { scope: 'word', lineIndex: 3, wordIndex: 0, deltaSec: 0.1 }), null);
  assert.equal(nudgeTimeline(tl, { scope: 'word', lineIndex: 0, wordIndex: 9, deltaSec: 0.1 }), null);
});
