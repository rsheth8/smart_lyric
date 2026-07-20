import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOnsets,
  refineTimelineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
} from '../app/align.js';

const SR = 16000;

/** PCM with a 0.18s burst of voice at each given position (seconds into the buffer). */
function voiceAt(times, totalSec = 14, amp = 0.4) {
  const pcm = new Float32Array(Math.round(totalSec * SR));
  for (const t of times) {
    const i0 = Math.round(t * SR);
    const i1 = Math.min(pcm.length, i0 + Math.round(0.18 * SR));
    for (let i = i0; i < i1; i++) pcm[i] = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
  }
  return pcm;
}

// The mic ring buffer is positional: index 0 is the OLDEST sample, i.e. song time
// (songNow − bufferDuration). With songNow=12 over a 14s buffer that origin is
// −2s, so a burst meant to land at song time T belongs at buffer position T + 2.
const SONG_NOW = 12;
const BUF_SEC = 14;
const WINDOW_START = SONG_NOW - BUF_SEC;
const atSongTimes = (songTimes) => voiceAt(songTimes.map((t) => t - WINDOW_START), BUF_SEC);

test('detectOnsets finds every syllable attack, not just the nearest one', () => {
  const onsets = detectOnsets(voiceAt([1.0, 1.5, 3.2, 3.4]), SR, 0, 5, {
    minE: 0.004,
    minRise: 0.002,
  });
  assert.ok(onsets.length >= 4, `expected >=4 attacks, got ${onsets.length}: ${onsets}`);
  for (const want of [1.0, 1.5, 3.2, 3.4]) {
    assert.ok(
      onsets.some((t) => Math.abs(t - want) < 0.08),
      `missed the attack at ${want}s (found ${onsets.map((t) => t.toFixed(2))})`
    );
  }
});

test('detectOnsets returns nothing on silence', () => {
  assert.deepEqual(detectOnsets(new Float32Array(SR * 3), SR, 0, 3), []);
});

// ---- rubato through the real alignment path -------------------------------
// Four evenly-weighted words. CTC anchors only the first and last, so words 1
// and 2 are interpolated — the case that used to spread them evenly and ignore
// how the singer actually phrased the line.
function installBridge() {
  global.window = {
    bar4bar: {
      alignSong: async ({ lines }) => ({
        aligned: lines.length,
        lines: lines.map((l) => ({
          words: l.words.map((_, i) => ({
            start: i === 0 ? 0.5 : 3.5,
            end: i === 0 ? 0.7 : 3.7,
            score: i === 0 || i === l.words.length - 1 ? 0.9 : 0.05,
          })),
        })),
      }),
      separateAvailable: async () => true,
      // "Separation" hands back the same PCM — the point is that the stem path
      // (and therefore onset-driven placement) is the one under test.
      separateVocals: async ({ left, sampleRate }) => ({
        left,
        right: left,
        sampleRate,
      }),
    },
  };
}

beforeEach(() => {
  installBridge();
  setVocalSeparationEnabled(true);
  setLiveVocalSeparationEnabled(true);
});
afterEach(() => {
  delete global.window;
});

const line = () => ({
  lines: [
    {
      start: 0.5,
      end: 4,
      words: [{ text: 'aa' }, { text: 'bb' }, { text: 'cc' }, { text: 'dd' }],
    },
  ],
});

test('interpolated words follow a rubato phrase instead of spreading evenly', async () => {
  // The singer HOLDS after word 0, then rushes words 1 and 2 together late.
  // Even spreading would put them near 1.5s and 2.5s; the real attacks are at
  // 2.9s and 3.2s.
  const mic = { sampleRate: SR, getOrderedPcm: () => atSongTimes([0.5, 2.9, 3.2, 3.5]) };
  const tl = line();
  const res = await refineTimelineFromMic(tl, mic, SONG_NOW, { maxLines: 2 });
  assert.ok(res && res.aligned === 1, `expected 1 aligned, got ${JSON.stringify(res)}`);

  const w = tl.lines[0].words;
  assert.ok(
    Math.abs(w[1].start - 2.9) < 0.25,
    `word 1 should land on the 2.9s attack, got ${w[1].start.toFixed(2)}`
  );
  assert.ok(
    Math.abs(w[2].start - 3.2) < 0.25,
    `word 2 should land on the 3.2s attack, got ${w[2].start.toFixed(2)}`
  );
  // The held word therefore keeps the long note instead of the spread stealing it.
  const held = w[0].end - w[0].start;
  assert.ok(held > 1.5, `word 0 should absorb the hold, lasted ${held.toFixed(2)}s`);
});

test('word order and line bounds survive onset fitting', async () => {
  const mic = { sampleRate: SR, getOrderedPcm: () => atSongTimes([0.5, 2.9, 3.2, 3.5]) };
  const tl = line();
  await refineTimelineFromMic(tl, mic, SONG_NOW, { maxLines: 2 });
  const w = tl.lines[0].words;
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i].start > w[i - 1].start, `word ${i} must start after ${i - 1}`);
    assert.ok(w[i].end > w[i].start, `word ${i} must have positive duration`);
  }
  assert.ok(w[0].start >= tl.lines[0].start - 1e-6, 'first word inside the line');
});

test('no usable attacks → falls back to the even spread (never worse)', async () => {
  // Only the two anchored words make sound; nothing to fit the middle to.
  const mic = { sampleRate: SR, getOrderedPcm: () => atSongTimes([0.5, 3.5]) };
  const tl = line();
  const res = await refineTimelineFromMic(tl, mic, SONG_NOW, { maxLines: 2 });
  assert.ok(res && res.aligned === 1);
  const w = tl.lines[0].words;
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i].start > w[i - 1].start, 'still monotonic without attacks');
  }
});
