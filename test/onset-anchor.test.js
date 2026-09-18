import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapToVocalOnset,
  instrumentalState,
  vocalStateAt,
  refineTimelineFromMic,
  setVocalSeparationEnabled,
  setLiveVocalSeparationEnabled,
} from '../app/align.js';

const SR = 16000;

/** Build PCM where each [from,to) second range has the given amplitude. */
function pcmFrom(spans, totalSec = 3) {
  const pcm = new Float32Array(Math.round(totalSec * SR));
  for (const [from, to, amp] of spans) {
    const i0 = Math.round(from * SR);
    const i1 = Math.round(to * SR);
    for (let i = i0; i < i1; i++) pcm[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return pcm;
}

// ---- gap-guarded onset snap (the "early off the jump" fix) ------------------

test('snap does NOT jump back across a silent trough onto an earlier transient', () => {
  // A drum hit at 0.90-0.95, silence, then the real vocal onset at 1.00.
  // CTC estimate is 1.005; a back-window of 0.12s can see the drum hit.
  const pcm = pcmFrom([
    [0.90, 0.95, 0.5],
    [1.00, 1.60, 0.4],
  ]);
  const t = snapToVocalOnset(pcm, SR, 1.005, { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 });
  assert.ok(t >= 0.97, `must not snap back onto the pre-vocal hit, got ${t}`);
});

test('snap still rides a continuous rise back to the true onset', () => {
  // Vocal ramps in from 0.95; no trough between the rise and the estimate.
  const pcm = pcmFrom([[0.95, 1.60, 0.4]]);
  const t = snapToVocalOnset(pcm, SR, 1.03, { back: 0.12, fwd: 0.06, minE: 0.004, minRise: 0.002 });
  assert.ok(t < 1.03, `should pull back to the onset, got ${t}`);
  assert.ok(t > 0.9, `but not wildly early, got ${t}`);
});

test('snap no-ops on silence (nothing to snap to)', () => {
  const pcm = new Float32Array(SR * 2);
  assert.equal(snapToVocalOnset(pcm, SR, 1.0, { back: 0.12, fwd: 0.06 }), 1.0);
});

// ---- instrumental hysteresis (smoother + more accurate ♪) -------------------

const step = (state, quiet, nextVocalIn, t) => instrumentalState(state, { quiet, nextVocalIn, t });

test('a short breath does not flip the instrumental indicator on', () => {
  let s = { on: false, quietSince: null };
  // 0.4s of quiet (a breath), then singing resumes.
  for (let t = 0; t < 0.4; t += 0.1) s = step(s, true, 4, t);
  assert.equal(s.on, false, 'breath must not trigger the ♪');
  s = step(s, false, 0, 0.5);
  assert.equal(s.on, false);
  assert.equal(s.quietSince, null, 'quiet timer resets once singing resumes');
});

test('sustained quiet over a long gap turns it on after the enter delay', () => {
  let s = { on: false, quietSince: null };
  s = step(s, true, 8, 0); // gap starts, 8s until next vocal
  assert.equal(s.on, false, 'not immediately');
  s = step(s, true, 7.5, 0.5);
  assert.equal(s.on, false, 'still inside the enter delay');
  s = step(s, true, 7.0, 1.0);
  assert.equal(s.on, true, 'on after ~0.9s of sustained quiet');
});

test('a gap too short to matter never turns it on', () => {
  let s = { on: false, quietSince: null };
  // Quiet, but the vocal returns in 1.0s → total gap ~2.0s < INSTR_MIN_GAP_SEC.
  for (let t = 0; t <= 1.0; t += 0.25) s = step(s, true, 1.0 - t + 1.0, t);
  assert.equal(s.on, false, 'short gaps stay silent — no ♪ flash');
});

test('an ordinary pause between verses stays silent (no ♪ takeover)', () => {
  let s = { on: false, quietSince: null };
  // 3.5s total gap: long enough to outlast the enter delay, but it's breathing
  // room between verses, not an interlude worth counting down.
  for (let t = 0; t <= 2.0; t += 0.25) s = step(s, true, 3.5 - t, t);
  assert.equal(s.on, false, 'a 3.5s gap is not an instrumental break');
});

test('clears early, before the vocal actually returns', () => {
  let s = { on: false, quietSince: null };
  for (let t = 0; t <= 2.0; t += 0.25) s = step(s, true, 8 - t, t);
  assert.equal(s.on, true, 'showing during the long gap');
  s = step(s, true, 0.4, 2.25); // vocal returns in 0.4s — inside the exit lead
  assert.equal(s.on, false, 'lyrics come back before the singer does');
});

test('stays on through a dip once showing (no re-entry cost)', () => {
  let s = { on: false, quietSince: null };
  for (let t = 0; t <= 2.0; t += 0.25) s = step(s, true, 8 - t, t);
  assert.equal(s.on, true);
  s = step(s, true, 5, 2.25);
  assert.equal(s.on, true, 'no flicker while the gap continues');
});

// ---- asymmetric vocal margins ----------------------------------------------

test('held tail keeps counting as singing longer than the pre-roll', () => {
  const intervals = [{ start: 1, end: 3 }];
  assert.equal(vocalStateAt(intervals, 3.3).active, true, 'held note tail still singing');
  assert.equal(vocalStateAt(intervals, 0.85).active, true, 'just before onset counts too');
  assert.equal(vocalStateAt(intervals, 0.7).active, false, 'but not far ahead of it');
});

// ---- first-word line anchoring (the "late off the jump" fix) ----------------
// A bridge whose CTC scores the FIRST word low (soft consonant / held vowel) and
// the rest high — exactly the case that used to anchor the line to word 2.
function installBridge(scores) {
  global.window = {
    bar4bar: {
      alignSong: async ({ lines }) => ({
        aligned: lines.length,
        lines: lines.map((l) => ({
          words: l.words.map((_, i) => ({
            start: 0.6 + i * 0.3,
            end: 0.6 + i * 0.3 + 0.2,
            score: scores[i],
          })),
        })),
      }),
      // Word CTC requires a stem; echo the window so placement stays CTC-driven
      // (silent mic PCM below → onset snap no-ops).
      separateAvailable: async () => true,
      separateVocals: async ({ left, sampleRate }) => {
        const n = (left.byteLength || left.length) / 4;
        return { left: new Float32Array(n), right: new Float32Array(n), sampleRate };
      },
    },
  };
}
beforeEach(() => {
  setVocalSeparationEnabled(true);
  setLiveVocalSeparationEnabled(true);
});
afterEach(() => {
  delete global.window;
});

const fourWordLine = () => ({
  lines: [{ start: 2, end: 4, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }],
});
// Silent PCM → the onset snap no-ops, isolating the extrapolation itself.
const mic = { sampleRate: 44100, getOrderedPcm: () => new Float32Array(44100 * 12) };

test('soft first word: line anchors back to its real onset, not to word 2', async () => {
  installBridge([0.1, 0.9, 0.9, 0.9]); // word 0 below the raw-mix gate (0.3)
  const tl = fourWordLine();
  const res = await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  assert.ok(res && res.aligned === 1, `expected 1 aligned, got ${JSON.stringify(res)}`);
  const w = tl.lines[0].words;
  // CTC put word 0 at 0.6 and word 1 at 0.9 (window-relative). Word 0 isn't an
  // anchor, so the line used to start at word 1 and shove word 0 on top of it
  // (~0.02 apart). Back-extrapolating at the line's own pace recovers the 0.3
  // spacing, i.e. word 0 lands on its true onset.
  const spacing = w[1].start - w[0].start;
  assert.ok(
    Math.abs(spacing - 0.3) < 0.05,
    `word 0 should sit ~0.3s before word 1 (its real onset), got ${spacing.toFixed(3)}`
  );
  assert.ok(
    Math.abs(tl.lines[0].start - w[0].start) < 1e-6,
    'the line starts exactly where its first word does'
  );
  assert.ok(Number.isFinite(tl.lines[0]._reanchorDelta), 'reanchor delta recorded for global lag');
});

test('confident first word: anchoring is unchanged', async () => {
  installBridge([0.9, 0.9, 0.9, 0.9]);
  const tl = fourWordLine();
  await refineTimelineFromMic(tl, mic, 10, { maxLines: 2 });
  const w = tl.lines[0].words;
  assert.ok(
    Math.abs(tl.lines[0].start - w[0].start) < 1e-6,
    'line still starts on word 0'
  );
  const spacing = w[1].start - w[0].start;
  assert.ok(
    Math.abs(spacing - 0.3) < 0.05,
    `CTC spacing preserved, got ${spacing.toFixed(3)}`
  );
});

test('back-extrapolation cannot cross into the previous line', async () => {
  installBridge([0.1, 0.9, 0.9, 0.9]);
  // Two lines; the first ends right where the second's words begin, so the
  // second line's back-extrapolation must be clamped by the floor.
  const tl = {
    lines: [
      { start: 0.5, end: 2.9, words: [{ text: 'x' }, { text: 'y' }] },
      { start: 3, end: 5, words: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] },
    ],
  };
  const res = await refineTimelineFromMic(tl, mic, 10, { maxLines: 4 });
  assert.ok(res && res.aligned >= 1);
  assert.ok(
    tl.lines[1].start >= tl.lines[0].start,
    'lines stay ordered after re-anchoring'
  );
});
