import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  refineTimelineWithAudio,
  refineTimelineFromMic,
  snapToVocalOnset,
  vocalStemMono16k,
  setVocalSeparationEnabled,
} from '../app/align.js';

// A 16 kHz timeline covering 20s, three lines of two words each. Word timing
// starts as an even syllable spread that the aligner should overwrite.
function makeTimeline() {
  const mk = (start, end, texts) => ({
    start,
    end,
    words: texts.map((text, i) => {
      const span = (end - start) / texts.length;
      return { text, start: start + i * span, end: start + (i + 1) * span };
    }),
  });
  return {
    lines: [
      mk(0, 4, ['hello', 'world']),
      mk(4, 8, ['sing', 'along']),
      mk(8, 12, ['last', 'line']),
    ],
  };
}

// Fake aligner. It receives window-rebased line times (line.start - windowStart)
// and returns per-word spans just after each line's rebased start — mirroring the
// real aligner, whose output is window-relative. Records lines per call.
function installFakeAligner(batchSizes) {
  global.window = {
    bar4bar: {
      alignSong: async ({ lines }) => {
        batchSizes.push(lines.length);
        return {
          aligned: lines.length,
          lines: lines.map((l) => ({
            words: l.words.map((_, i) => ({
              start: l.start + 0.3 + i * 0.8,
              end: l.start + 0.3 + i * 0.8 + 0.5,
              score: 0.9,
            })),
          })),
        };
      },
    },
  };
}

beforeEach(() => {
  installFakeAligner((globalThis.__batches = []));
});
afterEach(() => {
  delete global.window;
});

const pcm16k = new Float32Array(16000 * 12); // 12s of (silent) 16 kHz mono

test('aligns every line from pre-decoded PCM and marks the timeline aligned', async () => {
  const tl = makeTimeline();
  const res = await refineTimelineWithAudio(tl, pcm16k, { batchLines: 2 });
  assert.ok(res && res.aligned === 3, `expected 3 aligned, got ${JSON.stringify(res)}`);
  assert.equal(tl.aligned, true);
  assert.ok(tl.lines.every((l) => l._vocalAligned));
});

test('re-bases window-relative spans back into song time within line anchors', async () => {
  const tl = makeTimeline();
  await refineTimelineWithAudio(tl, pcm16k, { batchLines: 2 });
  // Line 2 spans [4,8); window start = 4 - pad. First word span 0.5s relative to
  // that window → lands near 4.25s, clamped to be >= line.start (4).
  const line = tl.lines[1];
  assert.ok(line.words[0].start >= 4 && line.words[0].start < 5, `w0 ${line.words[0].start}`);
  assert.ok(line.words[1].start > line.words[0].start, 'words stay ordered');
  assert.ok(line.words[1].end <= line.end + 1e-9, 'stays within line end');
});

test('batches by batchLines and reports progress to total', async () => {
  const tl = makeTimeline();
  const progress = [];
  await refineTimelineWithAudio(tl, pcm16k, {
    batchLines: 2,
    onProgress: (done, total) => progress.push([done, total]),
  });
  // 3 lines / batch 2 → batches of [2,1].
  assert.deepEqual(globalThis.__batches, [2, 1]);
  assert.deepEqual(progress[progress.length - 1], [3, 3]);
});

test('surfaces an aligner error instead of silently succeeding', async () => {
  global.window.bar4bar.alignSong = async () => ({ error: 'model unavailable', lines: [] });
  const tl = makeTimeline();
  const res = await refineTimelineWithAudio(tl, pcm16k, { batchLines: 2 });
  assert.equal(res.error, 'model unavailable');
  assert.equal(res.aligned, 0);
  assert.ok(!tl.aligned);
});

test('skips lines already vocal-aligned and no-ops a fully aligned timeline', async () => {
  const tl = makeTimeline();
  tl.lines.forEach((l) => (l._vocalAligned = true));
  tl.aligned = true;
  const res = await refineTimelineWithAudio(tl, pcm16k, { batchLines: 2 });
  assert.deepEqual(globalThis.__batches, []); // nothing sent to the aligner
  assert.deepEqual(res, { aligned: 0 });
});

test('re-anchors the line start to the real vocal onset (bounded by prior line)', async () => {
  // Single line nominally at [2,6); the aligner finds the vocal ~1.6s (earlier
  // than the catalog anchor). Line start should move earlier — but not before the
  // seed floor (line.start - search pad = 1.4).
  global.window.bar4bar.alignSong = async ({ lines }) => ({
    aligned: lines.length,
    lines: lines.map(() => ({
      words: [
        { start: 0.2, end: 0.6, score: 0.9 }, // window-relative → abs 1.6 (ws=1.4)
        { start: 1.6, end: 2.0, score: 0.9 },
      ],
    })),
  });
  const tl = { lines: [{ start: 2, end: 6, words: [{ text: 'hello' }, { text: 'world' }] }] };
  await refineTimelineWithAudio(tl, pcm16k, { batchLines: 4 });
  const line = tl.lines[0];
  assert.ok(line.start < 2, `line re-anchored earlier, got ${line.start}`);
  assert.ok(line.start >= 1.4 - 1e-9, 'not before the floor');
  assert.ok(Math.abs(line.words[0].start - line.start) < 1e-6, 'first word sits at line start');
});

test('interpolates a low-confidence word between confident anchors', async () => {
  // Middle word scores below threshold → placed between the two anchors by
  // syllable weight, not dropped to a heuristic guess or clamped onto a neighbor.
  global.window.bar4bar.alignSong = async ({ lines }) => ({
    aligned: lines.length,
    lines: lines.map(() => ({
      words: [
        { start: 0.5, end: 0.9, score: 0.9 },
        { start: 2.0, end: 2.4, score: 0.1 }, // low confidence
        { start: 3.5, end: 3.9, score: 0.9 },
      ],
    })),
  });
  const tl = {
    lines: [{ start: 0, end: 6, words: [{ text: 'a' }, { text: 'beautiful' }, { text: 'cat' }] }],
  };
  await refineTimelineWithAudio(tl, pcm16k, { batchLines: 4 });
  const w = tl.lines[0].words;
  assert.ok(w[0].start < w[1].start && w[1].start < w[2].start, 'strictly ordered');
  assert.ok(w[1].start > w[0].end - 1e-9 && w[1].start < w[2].start, 'middle word interpolated between anchors');
});

test('snapToVocalOnset moves to a clear energy rise and no-ops on silence', () => {
  const sr = 16000;
  const pcm = new Float32Array(sr); // 1s, silent until a burst at ~0.07s
  for (let i = Math.floor(0.07 * sr); i < sr; i++) pcm[i] = 0.2 * Math.sin(i / 4);
  const snapped = snapToVocalOnset(pcm, sr, 0.05); // query just before the onset
  assert.ok(snapped >= 0.06 && snapped <= 0.09, `snapped to onset, got ${snapped}`);
  // Silent buffer: nothing to snap to → returns the input time unchanged.
  assert.equal(snapToVocalOnset(new Float32Array(sr), sr, 0.5), 0.5);
});

test('relaxed snap gate (stem tuning) catches a weak onset the mix gate ignores', () => {
  const sr = 16000;
  const pcm = new Float32Array(sr);
  // Weak onset: energy ~0.006 — below the default minE (0.008), above relaxed (0.004).
  for (let i = Math.floor(0.07 * sr); i < sr; i++) pcm[i] = 0.0085 * Math.sin(i / 4);
  assert.equal(snapToVocalOnset(pcm, sr, 0.05), 0.05, 'default (mix) gate ignores it');
  const relaxed = snapToVocalOnset(pcm, sr, 0.05, { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 });
  assert.ok(relaxed >= 0.06 && relaxed <= 0.09, `relaxed (stem) gate snaps, got ${relaxed}`);
});

test('flags a mostly-interpolated line as uncertain and carries per-word scores', async () => {
  // Only the first word aligns confidently (0.9); the rest score below threshold
  // → 1 of 4 anchored → coverage 0.25 < 0.6 → uncertain.
  global.window.bar4bar.alignSong = async ({ lines }) => ({
    aligned: lines.length,
    lines: lines.map((l) => ({
      words: l.words.map((_, i) => ({ start: 0.5 + i * 0.4, end: 0.5 + i * 0.4 + 0.3, score: i === 0 ? 0.9 : 0.1 })),
    })),
  });
  const tl = { lines: [{ start: 0, end: 6, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }] };
  await refineTimelineWithAudio(tl, pcm16k, { batchLines: 4 });
  const line = tl.lines[0];
  assert.equal(line.uncertain, true);
  assert.ok(line.words[0].score >= 0.9 - 1e-9, 'anchor keeps its CTC score');
  assert.equal(line.words[1].score, 0, 'interpolated word scores 0');
});

test('a fully aligned line is not marked uncertain', async () => {
  global.window.bar4bar.alignSong = async ({ lines }) => ({
    aligned: lines.length,
    lines: lines.map((l) => ({ words: l.words.map((_, i) => ({ start: 0.3 + i * 0.5, end: 0.3 + i * 0.5 + 0.4, score: 0.9 })) })),
  });
  const tl = { lines: [{ start: 0, end: 6, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }] };
  await refineTimelineWithAudio(tl, pcm16k, { batchLines: 4 });
  assert.notEqual(tl.lines[0].uncertain, true);
});

test('mic path reaches parity: routes through applyWordSpans (score + uncertain)', async () => {
  // Only the first word aligns confidently → 1 of 4 anchored → uncertain, and
  // per-word scores are carried (same refinement as the whole-file path).
  global.window.bar4bar.alignSong = async ({ lines }) => ({
    aligned: lines.length,
    lines: lines.map((l) => ({
      words: l.words.map((_, i) => ({ start: 0.7 + i * 0.4, end: 0.7 + i * 0.4 + 0.3, score: i === 0 ? 0.9 : 0.1 })),
    })),
  });
  const timeline = { lines: [{ start: 2, end: 4, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }] };
  const mic = { sampleRate: 16000, getOrderedPcm: () => new Float32Array(16000 * 20) };
  const res = await refineTimelineFromMic(timeline, mic, 10, { maxLines: 2 });
  assert.ok(res && res.aligned === 1, `expected 1 aligned, got ${JSON.stringify(res)}`);
  const line = timeline.lines[0];
  assert.equal(line.uncertain, true);
  assert.ok(line.words[0].score >= 0.9 - 1e-9, 'anchor keeps its CTC score');
  assert.equal(line.words[1].score, 0, 'interpolated word scores 0');
  assert.ok(Array.isArray(res.timingSamples) && res.timingSamples.length >= 1, 'still measures timing');
});

test('vocal separation is gated by both the enable flag and model availability', async () => {
  const buf = new Float32Array(1000); // decodeStereo is never reached in these cases
  setVocalSeparationEnabled(false);
  assert.equal(await vocalStemMono16k(buf), null, 'disabled → null before any bridge call');
  setVocalSeparationEnabled(true);
  // Enabled but the test bridge has no separateAvailable → still null (no model).
  assert.equal(await vocalStemMono16k(buf), null, 'no model available → null');
});
