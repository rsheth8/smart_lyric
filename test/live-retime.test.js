import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLiveRetime,
  retimeCurrentLineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
  resetLiveSeparationStats,
} from '../app/align.js';

// ---- computeLiveRetime (pure) -----------------------------------------------
// Five single-syllable words ('aa' -> wordWeight 0.4+1 = 1.4), spread at the
// baseline pace (0.3 sec/weight -> 0.42s apart) so a slower/faster observed
// pace has room to move in either direction without hitting the
// [SEC_PER_WEIGHT_MIN, SEC_PER_WEIGHT_MAX] clamp unpredictably.
const w = (start, end) => ({ text: 'aa', start, end });
const baseWords = () => [w(0, 0.42), w(0.42, 0.84), w(0.84, 1.26), w(1.26, 1.68), w(1.68, 6)];
const LINE_START = 0;
const LINE_END = 6;

test('singer holds -> not-yet-reached words pushed later', () => {
  // Words 0,1 reached by nowSec=0.9 (margin 0.15 -> cutoff 0.75). Real attacks
  // at 0.05s and 0.8s: word1's attack landed far later than its 0.42s guess.
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.9, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [0.05, 0.8],
  });
  assert.ok(patches, 'expected a correction');
  assert.deepEqual(patches.map((p) => p.index), [2, 3, 4]);
  const byIndex = Object.fromEntries(patches.map((p) => [p.index, p]));
  assert.ok(byIndex[2].start > words[2].start, 'word 2 pushed later');
  assert.ok(byIndex[3].start > words[3].start, 'word 3 pushed later');
  assert.ok(byIndex[4].start > words[4].start, 'word 4 pushed later');
  assert.ok(byIndex[2].start < byIndex[3].start && byIndex[3].start < byIndex[4].start, 'monotonic');
});

test('singer rushes -> later not-yet-reached words pulled earlier', () => {
  // Same reached set, but the real attacks are close together (0.05s, 0.15s)
  // instead of 0.42s apart.
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.9, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [0.05, 0.15],
  });
  assert.ok(patches, 'expected a correction');
  const byIndex = Object.fromEntries(patches.map((p) => [p.index, p]));
  // The immediate next word is floored at "now" (it can't un-happen a moment
  // that already passed) — an accepted limitation, not a bug. Full correction
  // shows up from the word after.
  assert.ok(byIndex[2].start >= 0.9, 'word 2 cannot start before now');
  assert.ok(byIndex[3].start < words[3].start, 'word 3 pulled earlier');
  assert.ok(byIndex[4].start < words[4].start, 'word 4 pulled earlier');
});

test('no onsets in window -> no-op', () => {
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.9, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [],
  });
  assert.equal(patches, null);
});

test('fewer than minMatched onsets -> no-op', () => {
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.9, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [0.05],
  });
  assert.equal(patches, null);
});

test('already-reached words are never patched', () => {
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.9, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [0.05, 0.8],
  });
  assert.ok(patches);
  assert.ok(
    patches.every((p) => p.index >= 2),
    'no patch touches word 0 or 1'
  );
});

test('observed pace matches the existing estimate -> no-op (no jitter)', () => {
  // nowSec chosen so the floor doesn't bind, and onsets land exactly on the
  // baseline-pace guess -> the recomputed times reproduce the estimate.
  const words = baseWords();
  const patches = computeLiveRetime(words, 0.7, {
    lineStart: LINE_START,
    lineEnd: LINE_END,
    onsets: [0, 0.42],
  });
  assert.equal(patches, null);
});

// ---- retimeCurrentLineFromMic (IO wrapper) ---------------------------------
const SR = 16000;

function installBridge({ separateAvailable = true, onSeparate } = {}) {
  let calls = 0;
  global.window = {
    bar4bar: {
      separateAvailable: async () => separateAvailable,
      separateVocals: async ({ left, sampleRate }) => {
        calls++;
        onSeparate?.(calls);
        return { left, right: left, sampleRate };
      },
    },
  };
  return () => calls;
}

beforeEach(() => {
  setVocalSeparationEnabled(true);
  setLiveVocalSeparationEnabled(true);
  resetLiveSeparationStats();
});
afterEach(() => {
  delete global.window;
});

test('line scrolled out of the ring buffer -> no-op, no separation attempted', async () => {
  const calls = installBridge();
  const BUF_SEC = 6;
  const SONG_NOW = 10;
  const WINDOW_START = SONG_NOW - BUF_SEC; // 4
  // line.start (3) - ALIGN_SEARCH_PAD_SEC (0.6) = 2.4, well behind WINDOW_START (4).
  const timeline = {
    lines: [{ start: 3, end: 15, words: [{ text: 'aa' }, { text: 'bb' }] }],
  };
  const mic = { sampleRate: SR, getOrderedPcm: () => new Float32Array(SR * BUF_SEC) };
  const res = await retimeCurrentLineFromMic(timeline, mic, SONG_NOW);
  assert.equal(res, false);
  assert.equal(calls(), 0);
});

test('_liveRetimedAt blocks re-processing inside the rearm window, then retries after it', async () => {
  const calls = installBridge();
  const BUF_SEC = 14;
  const SONG_NOW = 8;
  const WINDOW_START = SONG_NOW - BUF_SEC; // -6
  const timeline = {
    lines: [{ start: 0, end: 10, words: [{ text: 'aa' }, { text: 'bb' }, { text: 'cc' }] }],
  };
  const mic = { sampleRate: SR, getOrderedPcm: () => new Float32Array(SR * BUF_SEC) };

  await retimeCurrentLineFromMic(timeline, mic, SONG_NOW, { minRearmSec: 1.5 });
  assert.equal(calls(), 1, 'first attempt separates once');
  assert.equal(timeline.lines[0]._liveRetimedAt, SONG_NOW);

  await retimeCurrentLineFromMic(timeline, mic, SONG_NOW + 0.1, { minRearmSec: 1.5 });
  assert.equal(calls(), 1, 'inside the rearm window: no new attempt');

  await retimeCurrentLineFromMic(timeline, mic, SONG_NOW + 1.6, { minRearmSec: 1.5 });
  assert.equal(calls(), 2, 'past the rearm window: retries');
  void WINDOW_START;
});

test('already fully CTC-aligned lines are skipped entirely', async () => {
  const calls = installBridge();
  const timeline = {
    lines: [
      {
        start: 0,
        end: 10,
        words: [{ text: 'aa' }, { text: 'bb' }, { text: 'cc' }],
        _vocalAligned: true,
      },
    ],
  };
  const mic = { sampleRate: SR, getOrderedPcm: () => new Float32Array(SR * 14) };
  const res = await retimeCurrentLineFromMic(timeline, mic, 8);
  assert.equal(res, false);
  assert.equal(calls(), 0);
});

test('no vocal stem available -> no-op, never falls back to raw-mix onset detection', async () => {
  const calls = installBridge({ separateAvailable: false });
  const words = [{ text: 'aa' }, { text: 'bb' }, { text: 'cc' }];
  const timeline = { lines: [{ start: 0, end: 10, words }] };
  const mic = { sampleRate: SR, getOrderedPcm: () => new Float32Array(SR * 14) };
  const res = await retimeCurrentLineFromMic(timeline, mic, 8);
  assert.equal(res, false);
  assert.equal(calls(), 0, 'separateVocals never called when separation is unavailable');
  assert.deepEqual(timeline.lines[0].words, words, 'words left untouched');
});
