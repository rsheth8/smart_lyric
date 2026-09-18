import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  refineTimelineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
} from '../app/align.js';

// Capture-latency conversion on the live mic/loopback path.
//
// Audio reaching the capture is DELAYED by output latency, so the ring buffer's
// newest sample is older than the playhead. refineTimelineFromMic has no choice
// but to label it as ending at songNowSec — measuring that very gap is what the
// SyncEstimator does. The bug this guards: those capture-labeled CTC times used
// to be written straight into the canonical lyric timeline, so the display's
// syncOffset then applied the same latency a SECOND time, and the next round of
// measurements "corrected" an already-shifted timeline. That feedback loop is
// what made sync appear to lock and then drift back off.
//
// The contract: word times written into the timeline must be in SOURCE time
// (latency converted out), while the timing samples fed to the estimator stay
// in raw heard coordinates (they are the measurement of the latency itself).

const SR = 16000;
const SONG_NOW = 12;
const BUF_SEC = 14;

// Two confidently-aligned words, so placement is driven by the CTC anchors
// rather than interpolation — the thing under test is the coordinate, not the fit.
function installBridge() {
  global.window = {
    bar4bar: {
      alignSong: async ({ lines }) => ({
        aligned: lines.length,
        lines: lines.map((l) => ({
          words: l.words.map((_, i) => ({
            start: 0.6 + i,
            end: 0.9 + i,
            score: 0.9,
          })),
        })),
      }),
      // Stem required for word CTC. Echo silence so onset snap no-ops — this
      // test is about coordinate conversion, not energy fitting.
      separateAvailable: async () => true,
      separateVocals: async ({ left, sampleRate }) => {
        const n = (left.byteLength || left.length) / 4;
        return { left: new Float32Array(n), right: new Float32Array(n), sampleRate };
      },
    },
  };
}

const timeline = () => ({
  lines: [{ start: 0.5, end: 4, words: [{ text: 'aa' }, { text: 'bb' }] }],
});

// Silence: snapToVocalOnset no-ops on it, so nothing perturbs the placement.
const mic = { sampleRate: SR, getOrderedPcm: () => new Float32Array(SR * BUF_SEC) };

beforeEach(() => {
  installBridge();
  setVocalSeparationEnabled(true);
  setLiveVocalSeparationEnabled(true);
});
afterEach(() => {
  delete global.window;
});

async function firstWordStart(expectedOffset) {
  const tl = timeline();
  const res = await refineTimelineFromMic(tl, mic, SONG_NOW, { maxLines: 2, expectedOffset });
  assert.ok(res && res.aligned === 1, `expected 1 aligned line, got ${JSON.stringify(res)}`);
  return tl.lines[0].words[0].start;
}

test('measured output latency is converted OUT of the written timeline', async () => {
  const noLatency = await firstWordStart(0);
  // -0.3 is what the estimator reports for 300ms of output latency
  // (value = expected − heard, so a delayed signal reads negative).
  const withLatency = await firstWordStart(-0.3);
  assert.ok(
    Math.abs((noLatency - withLatency) - 0.3) < 1e-6,
    `a 300ms latency must shift written word times by exactly 300ms, ` +
      `got ${(noLatency - withLatency).toFixed(4)}s ` +
      `(${noLatency.toFixed(3)} → ${withLatency.toFixed(3)})`
  );
});

test('the conversion is linear in the measured latency (no double-application)', async () => {
  const base = await firstWordStart(0);
  const half = await firstWordStart(-0.2);
  const full = await firstWordStart(-0.4);
  // Doubling the latency must double the shift. If the offset were applied
  // twice anywhere in the path this comes out 2x too large.
  assert.ok(Math.abs((base - half) - 0.2) < 1e-6, `0.2s latency → 0.2s shift, got ${(base - half).toFixed(4)}`);
  assert.ok(Math.abs((base - full) - 0.4) < 1e-6, `0.4s latency → 0.4s shift, got ${(base - full).toFixed(4)}`);
});

test('timing samples stay in HEARD coordinates (they measure the latency)', async () => {
  // The estimator's input must NOT be latency-converted, or it would be
  // measuring a timeline that already had its own answer folded into it —
  // the feedback loop that made a good lock decay.
  const tl = timeline();
  const res = await refineTimelineFromMic(tl, mic, SONG_NOW, { maxLines: 2, expectedOffset: -0.3 });
  const tl2 = timeline();
  const res2 = await refineTimelineFromMic(tl2, mic, SONG_NOW, { maxLines: 2, expectedOffset: 0 });
  const v1 = res.timingSamples?.find((s) => s.source === 'ctc')?.value;
  const v2 = res2.timingSamples?.find((s) => s.source === 'ctc')?.value;
  assert.ok(Number.isFinite(v1) && Number.isFinite(v2), 'expected a ctc timing sample from both runs');
  assert.ok(
    Math.abs(v1 - v2) < 1e-6,
    `the measurement must not move with the offset already applied, got ${v1} vs ${v2}`
  );
});
