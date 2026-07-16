import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrellis,
  backtrack,
  mergeRepeats,
  alignTokens,
} from '../lib/forced-align.mjs';

// Synthetic label set: 0 = blank, 1 = '|' (word separator), 2 = 'A', 3 = 'B'.
const BLANK = 0;
const SEP = 1;
const NLABEL = 4;

// Build a log-prob emission frame that is confident about `target`.
function frame(target) {
  const p = new Array(NLABEL).fill(Math.log(0.01));
  p[target] = Math.log(0.97);
  return p;
}

// A sequence of labels → an emission matrix.
function emissionFrom(labels) {
  return labels.map(frame);
}

test('alignTokens recovers a single word span from clear emissions', () => {
  //             f0  f1  f2 f3 f4 f5  f6  f7
  const labels = [SEP, SEP, 2, 2, 3, 3, SEP, SEP];
  const emission = emissionFrom(labels);
  const tokens = [SEP, 2, 3, SEP]; // "|AB|"
  const words = alignTokens(emission, tokens, { blankId: BLANK, separatorId: SEP });
  assert.equal(words.length, 1);
  const [w] = words;
  assert.ok(w.start >= 1 && w.start <= 3, `start ${w.start}`);
  assert.ok(w.end >= 5 && w.end <= 7, `end ${w.end}`);
  assert.ok(w.end > w.start);
  assert.ok(w.score > 0.3, `score ${w.score}`);
});

test('alignTokens keeps two words in order with a gap between them', () => {
  const labels = [SEP, 2, 2, SEP, 3, 3, SEP];
  const emission = emissionFrom(labels);
  const tokens = [SEP, 2, SEP, 3, SEP]; // "|A|B|"
  const words = alignTokens(emission, tokens, { blankId: BLANK, separatorId: SEP });
  assert.equal(words.length, 2);
  const [a, b] = words;
  assert.ok(a.end <= b.start, `A(${a.start},${a.end}) should precede B(${b.start},${b.end})`);
  assert.ok(a.start < b.start);
});

test('backtrack path has monotonically non-decreasing token indices', () => {
  const labels = [SEP, 2, 3, SEP];
  const emission = emissionFrom(labels);
  const tokens = [SEP, 2, 3, SEP];
  const trellis = buildTrellis(emission, tokens, BLANK);
  const path = backtrack(trellis, emission, tokens, BLANK);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].tokenIndex >= path[i - 1].tokenIndex, 'token index must not go backwards');
  }
  // The path spans exactly the available frames.
  assert.equal(path[0].timeIndex, 0);
  assert.equal(path[path.length - 1].timeIndex, emission.length - 1);
});

test('mergeRepeats collapses repeated frames into per-token segments', () => {
  const labels = [SEP, 2, 2, 3, SEP];
  const emission = emissionFrom(labels);
  const tokens = [SEP, 2, 3, SEP];
  const trellis = buildTrellis(emission, tokens, BLANK);
  const path = backtrack(trellis, emission, tokens, BLANK);
  const segs = mergeRepeats(path);
  // One segment per distinct token in the path, each a half-open [start,end) range.
  for (const s of segs) assert.ok(s.end > s.start);
  // Segments cover the frames contiguously and in order.
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
});

test('alignTokens returns null when there are fewer frames than tokens', () => {
  const emission = emissionFrom([SEP, 2]);
  const tokens = [SEP, 2, 3, SEP];
  assert.equal(alignTokens(emission, tokens, { blankId: BLANK, separatorId: SEP }), null);
});
