import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVocalIntervals, lyricGapStateAt, vocalStateAt } from '../app/align.js';

// Build a 16 kHz stem: silence [0,1), vocal [1,3), silence [3,5), vocal [5,6).
function makeStem() {
  const sr = 16000;
  const pcm = new Float32Array(sr * 6);
  const tone = (from, to) => {
    for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i++) pcm[i] = 0.1 * Math.sin(i / 5);
  };
  tone(1, 3);
  tone(5, 6);
  return { pcm, sr };
}

test('computeVocalIntervals finds the sung regions and skips silence', () => {
  const { pcm, sr } = makeStem();
  const iv = computeVocalIntervals(pcm, sr);
  assert.equal(iv.length, 2, `two vocal regions, got ${iv.length}`);
  assert.ok(Math.abs(iv[0].start - 1) < 0.1 && Math.abs(iv[0].end - 3) < 0.1, JSON.stringify(iv[0]));
  assert.ok(Math.abs(iv[1].start - 5) < 0.1 && Math.abs(iv[1].end - 6) < 0.1, JSON.stringify(iv[1]));
});

test('computeVocalIntervals returns nothing for a silent stem', () => {
  assert.deepEqual(computeVocalIntervals(new Float32Array(16000 * 3), 16000), []);
});

test('computeVocalIntervals bridges a short breath gap', () => {
  const sr = 16000;
  const pcm = new Float32Array(sr * 3);
  // sing [0,1), 0.2s breath, sing [1.2,2.5) — should merge into one interval.
  for (let i = 0; i < sr; i++) pcm[i] = 0.1 * Math.sin(i / 5);
  for (let i = Math.floor(1.2 * sr); i < Math.floor(2.5 * sr); i++) pcm[i] = 0.1 * Math.sin(i / 5);
  const iv = computeVocalIntervals(pcm, sr);
  assert.equal(iv.length, 1, `merged across the breath, got ${iv.length}`);
});

test('vocalStateAt reports active inside, and countdown to the next region', () => {
  const intervals = [
    { start: 1, end: 3 },
    { start: 5, end: 6 },
  ];
  assert.equal(vocalStateAt(intervals, 2).active, true); // inside first region
  const gap = vocalStateAt(intervals, 4); // between regions
  assert.equal(gap.active, false);
  assert.ok(Math.abs(gap.nextVocalIn - 1) < 1e-9, 'next vocal in ~1s');
  assert.equal(vocalStateAt(intervals, 7).active, false); // after the last
  assert.equal(vocalStateAt(intervals, 7).nextVocalIn, null);
});

test('vocalStateAt assumes active when no interval data (unknown)', () => {
  assert.equal(vocalStateAt(null, 5).active, true);
  assert.equal(vocalStateAt([], 5).active, true);
});

test('lyricGapStateAt treats a long held-tail bridge as instrumental', () => {
  // Line sung ~[10,12], last word holds to next line at 25 → interlude after hold.
  const lines = [
    {
      start: 10,
      end: 25,
      words: [
        { text: 'hello', start: 10, end: 10.5 },
        { text: 'world', start: 10.5, end: 25 },
      ],
    },
    { start: 25, end: 28, words: [{ text: 'again', start: 25, end: 28 }] },
  ];
  assert.equal(lyricGapStateAt(lines, 11).active, true, 'still on early/held word');
  const mid = lyricGapStateAt(lines, 14); // past 10.5+2.0 hold
  assert.equal(mid.active, false);
  assert.ok(Math.abs(mid.nextVocalIn - 11) < 1e-9, `countdown ~11s, got ${mid.nextVocalIn}`);
  assert.equal(lyricGapStateAt(lines, 25.5).active, true, 'next line is singing');
});

test('lyricGapStateAt ignores normal short gaps between lines', () => {
  const lines = [
    {
      start: 0,
      end: 3,
      words: [
        { text: 'a', start: 0, end: 1 },
        { text: 'b', start: 1, end: 3 },
      ],
    },
    { start: 3, end: 5, words: [{ text: 'c', start: 3, end: 5 }] },
  ];
  // leftover after hold ≈ 0 — not an interlude
  assert.equal(lyricGapStateAt(lines, 2.5).active, true);
});

test('lyricGapStateAt marks a long intro as instrumental', () => {
  const lines = [{ start: 12, end: 15, words: [{ text: 'go', start: 12, end: 15 }] }];
  const intro = lyricGapStateAt(lines, 2);
  assert.equal(intro.active, false);
  assert.ok(Math.abs(intro.nextVocalIn - 10) < 1e-9);
  assert.equal(lyricGapStateAt(lines, 11.2).active, true, 'short lead-in stays active');
});

test('lyricGapStateAt marks the outro after the last line', () => {
  const lines = [
    {
      start: 0,
      end: 10,
      words: [{ text: 'bye', start: 0, end: 10 }],
    },
  ];
  // During long single-word hold past maxHold with leftover ≥ minGap → instrumental
  assert.equal(lyricGapStateAt(lines, 5).active, false);
  assert.equal(lyricGapStateAt(lines, 5).nextVocalIn, null);
  assert.equal(lyricGapStateAt(lines, 12).active, false);
});
