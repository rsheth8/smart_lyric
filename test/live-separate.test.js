import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  refineTimelineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
  liveSeparationStats,
  resetLiveSeparationStats,
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

test('with live separation OFF, skips word CTC (keeps syllable estimates)', async () => {
  setLiveVocalSeparationEnabled(false);
  const tl = oneLine();
  const before = tl.lines[0].words.map((w) => w.start);
  const res = await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  assert.equal(sepCalls.length, 0, 'separateVocals not called when disabled');
  // Raw-mix CTC is refused — estimated starts stay put, nothing marked aligned.
  assert.ok(!res || res.aligned === 0, `expected 0 aligned, got ${JSON.stringify(res)}`);
  assert.deepEqual(
    tl.lines[0].words.map((w) => w.start),
    before,
    'word starts unchanged without a stem'
  );
  assert.equal(tl.lines[0]._vocalAligned, undefined);
});

test('does not separate on the timing-only pass', async () => {
  const tl = oneLine();
  await refineTimelineFromMic(tl, mic, 10, { maxLines: 2, timingOnly: true });
  assert.equal(sepCalls.length, 0, 'timing-only stays on the raw mix');
});

test('short windows skip separation and refuse raw-mix word CTC', async () => {
  // A <2s window: not worth MDX's fixed cost → no stem → no word CTC.
  const shortMic = { sampleRate: 44100, getOrderedPcm: () => new Float32Array(44100 * 1) };
  const tl = { lines: [{ start: 0, end: 0.8, words: [{ text: 'a' }, { text: 'b' }] }] };
  const res = await refineTimelineFromMic(tl, shortMic, 1, { maxLines: 2 });
  assert.equal(sepCalls.length, 0, 'no separation on a sub-2s window');
  assert.ok(!res || res.aligned === 0, 'no raw-mix word CTC on a short window');
});

// ---- auto-fallback plumbing ----------------------------------------------
// The pace POLICY is covered exhaustively in test/live-sep-pace.test.js; these
// check the flag is exposed and cleared, since that is what gates the raw path.

test('a fast machine is never marked paused', async () => {
  const tl = oneLine();
  await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  assert.equal(liveSeparationStats().paused, false, 'mock separation is instant — no fallback');
});

test('resetting per song clears the auto-pause', () => {
  resetLiveSeparationStats();
  const s = liveSeparationStats();
  assert.equal(s.paused, false);
  assert.equal(s.sepCount, 0);
  assert.equal(s.firstSepSec, 0, 'warm-up baseline is cleared too');
});

// ---- mid-line probe corroboration ----------------------------------------
// Every probe in a line measures the same constant latency, so a mid-line probe
// that disagrees with its own line's entrance found a drum hit or an ad-lib, not
// the word. Unfiltered, those scatter the estimate enough that the median stops
// being trustworthy and the lock never happens ("6 samples, 34% agree").

test('a mid-line probe that disagrees with its line entrance is discarded', async () => {
  const SR = 16000;
  const SONG_NOW = 12;
  const BUF = 14;
  const WSTART = SONG_NOW - BUF;
  const pcm = new Float32Array(BUF * SR);
  const burst = (songT) => {
    const i0 = Math.round((songT - WSTART) * SR);
    for (let i = i0; i < i0 + Math.round(0.18 * SR); i++) {
      pcm[i] = 0.4 * Math.sin((2 * Math.PI * 200 * i) / SR);
    }
  };
  // Line entrance lands on time at 1.0; the "word" at 5.0 has NO vocal there,
  // only a stray transient far earlier — so its measurement must be rejected.
  burst(1.0);
  burst(3.2); // stray hit, ~1.8s away from where the word is expected
  const mic = { sampleRate: SR, getOrderedPcm: () => pcm };
  const tl = {
    lines: [
      {
        start: 1,
        end: 6,
        words: [
          { text: 'a', start: 1.0, end: 1.3 },
          { text: 'b', start: 5.0, end: 5.3 }, // preceded by a big gap → probed
        ],
      },
    ],
  };
  const res = await refineTimelineFromMic(tl, mic, SONG_NOW, { timingOnly: true, maxLines: 2 });
  const samples = res?.timingSamples || [];
  assert.ok(samples.length >= 1, `expected the line entrance sample, got ${samples.length}`);
  const spread = Math.max(...samples.map((s) => s.value)) - Math.min(...samples.map((s) => s.value));
  assert.ok(
    spread <= 0.15 + 1e-9,
    `kept samples must corroborate each other, spread was ${spread.toFixed(2)}s`
  );
});
