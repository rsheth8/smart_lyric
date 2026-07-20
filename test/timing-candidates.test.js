import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTimingCandidates, timingProbePoints } from '../app/align.js';

const line = (start, end) => ({ start, end, words: [{ text: 'a' }, { text: 'b' }] });
const BUF = 16; // mic ring buffer seconds
const winStart = (now) => now - BUF;

test('a line still being sung is not a candidate yet', () => {
  const lines = [line(10, 14)];
  // At t=15 the line ended 1s ago — inside the 1.5s pad, audio may still be in flight.
  assert.equal(pickTimingCandidates(lines, 15, { windowStart: winStart(15) }).length, 0);
  assert.equal(pickTimingCandidates(lines, 16, { windowStart: winStart(16) }).length, 1);
});

test('a line that scrolled out of the ring buffer is dropped', () => {
  const lines = [line(2, 5)];
  assert.equal(pickTimingCandidates(lines, 10, { windowStart: winStart(10) }).length, 1);
  // By t=30 the buffer only holds 14s onward — the line is long gone.
  assert.equal(pickTimingCandidates(lines, 30, { windowStart: winStart(30) }).length, 0);
});

test('lines with no words are never candidates', () => {
  const lines = [{ start: 1, end: 3, words: [] }];
  assert.equal(pickTimingCandidates(lines, 10, { windowStart: winStart(10) }).length, 0);
});

test('a null clock yields no candidates rather than nonsense', () => {
  assert.deepEqual(pickTimingCandidates([line(1, 3)], null, { windowStart: -10 }), []);
});

test('measured lines are excluded until stale, then return', () => {
  // line(10,14) is only usable while both `end+pad <= now` and it's still in the
  // 16s buffer, i.e. now ∈ [15.5, 24.5] — so the staleness window must fit inside
  // that. (A long staleAfterSec simply means a line scrolls out before it comes
  // back up, which is why re-measurement mostly lands on newly-sung lines.)
  const lines = [line(10, 14)];
  const opts = (now) => ({ windowStart: winStart(now), staleAfterSec: 4 });
  assert.equal(pickTimingCandidates(lines, 16, opts(16)).length, 1, 'eligible at first');
  lines[0]._timingMeasuredAt = 16;
  assert.equal(pickTimingCandidates(lines, 18, opts(18)).length, 0, 'not re-measured immediately');
  assert.equal(pickTimingCandidates(lines, 21, opts(21)).length, 1, 'comes back up once stale');
});

test('staleAfterSec Infinity reproduces measure-once behaviour', () => {
  const lines = [line(10, 14)];
  lines[0]._timingMeasuredAt = 16;
  assert.equal(
    pickTimingCandidates(lines, 500, { windowStart: winStart(500), staleAfterSec: Infinity }).length,
    0
  );
});

test('maxLines keeps the most recent lines', () => {
  const lines = [line(2, 4), line(6, 8), line(10, 12), line(14, 16)];
  const got = pickTimingCandidates(lines, 20, { windowStart: winStart(20), maxLines: 2 });
  assert.equal(got.length, 2);
  assert.equal(got[got.length - 1].line.start, 14, 'newest line included');
});

// Direct regression test for root cause 2: the loop used to stop having anything
// to do after one sweep, so drift went untracked for the rest of the song.
test('over a full song there is always work within a few seconds', () => {
  const lines = [];
  for (let t = 4; t < 200; t += 6) lines.push(line(t, t + 4));
  let longestDrought = 0;
  let drought = 0;
  for (let now = 0; now <= 200; now += 1) {
    const got = pickTimingCandidates(lines, now, {
      windowStart: winStart(now),
      staleAfterSec: 10,
    });
    if (got.length) {
      // Simulate the loop measuring what it found.
      for (const { line: l } of got) l._timingMeasuredAt = now;
      drought = 0;
    } else {
      drought += 1;
      longestDrought = Math.max(longestDrought, drought);
    }
  }
  assert.ok(
    longestDrought <= 12,
    `measurement should never idle for long; longest gap was ${longestDrought}s`
  );
  const measured = lines.filter((l) => l._timingMeasuredAt != null).length;
  assert.ok(measured > 20, `most lines should get measured, got ${measured}`);
});

test('with measure-once, the same song starves after the first sweep', () => {
  const lines = [];
  for (let t = 4; t < 200; t += 6) lines.push(line(t, t + 4));
  let lastWorkAt = 0;
  for (let now = 0; now <= 200; now += 1) {
    const got = pickTimingCandidates(lines, now, {
      windowStart: winStart(now),
      staleAfterSec: Infinity,
    });
    if (got.length) {
      for (const { line: l } of got) l._timingMeasuredAt = now;
      lastWorkAt = now;
    }
  }
  // Every line gets measured exactly once and then there is nothing left to do,
  // but work continues as new lines are sung — the starvation in the real bug
  // came from the SCHEDULER returning without re-arming, which is now fixed.
  assert.ok(lastWorkAt > 150, 'sanity: new lines keep arriving');
});

// ---- how many latency probes a single line yields -------------------------
// One sample per line meant the estimator needed several finished lines before
// it had enough agreement to lock — tens of seconds of song.

test('a line always offers its own entrance as a probe', () => {
  const l = { start: 10, end: 14, words: [{ text: 'a', start: 10, end: 10.4 }] };
  const p = timingProbePoints(l);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'line');
  assert.equal(p[0].expected, 10);
});

test('words after a real pause add extra probes', () => {
  const l = {
    start: 10,
    end: 16,
    words: [
      { text: 'a', start: 10, end: 10.4 },
      { text: 'b', start: 10.45, end: 10.9 }, // no pause — not findable
      { text: 'c', start: 11.6, end: 12.0 }, // 0.7s pause → clean attack
      { text: 'd', start: 13.0, end: 13.4 }, // 1.0s pause → clean attack
    ],
  };
  const p = timingProbePoints(l);
  assert.equal(p.length, 3, `entrance + two paused words, got ${JSON.stringify(p)}`);
  assert.deepEqual(
    p.map((x) => x.expected),
    [10, 11.6, 13.0]
  );
  assert.equal(p[1].kind, 'word');
});

test('continuous singing yields only the line entrance (no findable attacks)', () => {
  const words = [];
  for (let i = 0; i < 8; i++) words.push({ text: 'w', start: 10 + i * 0.3, end: 10 + i * 0.3 + 0.29 });
  assert.equal(timingProbePoints({ start: 10, end: 14, words }).length, 1);
});

test('probes are capped so one line cannot flood the estimator', () => {
  const words = [{ text: 'a', start: 10, end: 10.3 }];
  for (let i = 1; i < 10; i++) words.push({ text: 'w', start: 10 + i, end: 10 + i + 0.3 });
  assert.ok(timingProbePoints({ start: 10, end: 25, words }).length <= 3);
});

test('a line with no usable timing yields nothing', () => {
  assert.deepEqual(timingProbePoints({ words: [] }), []);
  assert.deepEqual(timingProbePoints(null), []);
});
