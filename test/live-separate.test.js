import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  refineTimelineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
} from '../app/align.js';

// A bridge that both aligns and separates. alignSong returns fixed per-word scores;
// the [0.9, 0.2, 0.2, 0.2] pattern is the discriminator: with the RAW-mix gate
// (minScore 0.3) only word 0 anchors → line uncertain; with the STEM gate (0.15)
// all four anchor → line confident. separateVocals just echoes the window length so
// the downstream resample/align still lines up, and records that it was called.
function installBridge({ sepCalls }) {
  global.window = {
    bar4bar: {
      alignSong: async ({ lines }) => ({
        aligned: lines.length,
        lines: lines.map((l) => ({
          words: l.words.map((_, i) => ({
            start: 0.6 + i * 0.3,
            end: 0.6 + i * 0.3 + 0.2,
            score: i === 0 ? 0.9 : 0.2,
          })),
        })),
      }),
      separateAvailable: async () => true,
      separateVocals: async ({ left, sampleRate }) => {
        sepCalls.push({ len: (left.byteLength || left.length) / 4, sampleRate });
        const n = (left.byteLength || left.length) / 4;
        return { left: new Float32Array(n), right: new Float32Array(n), sampleRate };
      },
    },
  };
}

let sepCalls;
beforeEach(() => {
  sepCalls = [];
  installBridge({ sepCalls });
  setVocalSeparationEnabled(true); // master
  setLiveVocalSeparationEnabled(true); // live-specific
});
afterEach(() => {
  delete global.window;
});

const oneLine = () => ({
  lines: [{ start: 2, end: 4, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }],
});
const mic = { sampleRate: 44100, getOrderedPcm: () => new Float32Array(44100 * 12) };

test('separates the batch window and applies stem tuning (0.2 word becomes an anchor)', async () => {
  const tl = oneLine();
  const res = await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  assert.ok(res && res.aligned === 1, `expected 1 aligned, got ${JSON.stringify(res)}`);
  assert.equal(sepCalls.length >= 1, true, 'separateVocals was called for the window');
  const line = tl.lines[0];
  // Stem gate (0.15) → the 0.2 word counts as a confident anchor, so the line is
  // NOT flagged uncertain and the word keeps its real CTC score.
  assert.notEqual(line.uncertain, true);
  assert.ok(line.words[1].score >= 0.2 - 1e-9, `stem anchor keeps score, got ${line.words[1].score}`);
});

test('with live separation OFF, falls back to raw mix (0.2 word interpolated)', async () => {
  setLiveVocalSeparationEnabled(false);
  const tl = oneLine();
  const res = await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  assert.ok(res && res.aligned === 1, `expected 1 aligned, got ${JSON.stringify(res)}`);
  assert.equal(sepCalls.length, 0, 'separateVocals not called when disabled');
  const line = tl.lines[0];
  // Raw gate (0.3) → only word 0 anchors → 1/4 coverage → uncertain, rest score 0.
  assert.equal(line.uncertain, true);
  assert.equal(line.words[1].score, 0, 'interpolated word scores 0 on the raw path');
});

test('does not separate on the timing-only pass', async () => {
  const tl = oneLine();
  await refineTimelineFromMic(tl, mic, 10, { maxLines: 2, timingOnly: true });
  assert.equal(sepCalls.length, 0, 'timing-only stays on the raw mix');
});

test('short windows skip separation (below MIN_STEM_WINDOW_SEC)', async () => {
  // A <2s window: not worth MDX's fixed cost → raw mix, no separation call.
  const shortMic = { sampleRate: 44100, getOrderedPcm: () => new Float32Array(44100 * 1) };
  await refineTimelineFromMic({ lines: [{ start: 0, end: 0.8, words: [{ text: 'a' }, { text: 'b' }] }] }, shortMic, 1, {
    maxLines: 2,
  });
  assert.equal(sepCalls.length, 0, 'no separation on a sub-2s window');
});
