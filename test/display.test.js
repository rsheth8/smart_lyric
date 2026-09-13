import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  centerTranslate,
  wipeProgress,
  wordPhase,
  holdAmount,
  syllableGlow,
  attackAmount,
  cutAmount,
  wipeWithCut,
  countInState,
  countInWindowForGap,
  wordLeadIn,
  confidenceDim,
  inBreathGap,
  resolveActiveLine,
  LEADIN_WORD,
  SINGER_LEAD,
} from '../app/display.js';

// display.js imports align/lrc at module scope; those are Node-safe. Browser-only
// APIs stay inside the Display class.

test('centers a line by translating its midpoint to the viewport middle', () => {
  // A line 80px tall whose top sits at 1000px, in an 800px-tall viewport.
  // Its center is at 1040 → to reach 400 we must translate up by 640.
  assert.equal(centerTranslate(800, 1000, 80), -640);
});

test('the first line (top ~0) is pushed down to the middle', () => {
  assert.equal(centerTranslate(800, 0, 80), 360);
});

test('a line already centered needs no translation', () => {
  // center at 400 in an 800 viewport → translate 0.
  assert.equal(centerTranslate(800, 360, 80), 0);
});

test('returns an integer (avoids sub-pixel jitter)', () => {
  assert.equal(centerTranslate(801, 101, 33), Math.round(801 / 2 - (101 + 33 / 2)));
  assert.ok(Number.isInteger(centerTranslate(801, 101, 33)));
});

test('wipeProgress tracks the sung span', () => {
  assert.equal(wipeProgress(0.5, 1, 2), 0);
  assert.equal(wipeProgress(1, 1, 2), 0);
  assert.equal(wipeProgress(1.5, 1, 2), 0.5);
  assert.equal(wipeProgress(2, 1, 2), 1);
  assert.equal(wipeProgress(3, 1, 2), 1);
});

test('wordPhase includes lead-in before the beat', () => {
  assert.equal(wordPhase(0, 1, 2), 'upcoming');
  assert.equal(wordPhase(1 - LEADIN_WORD, 1, 2), 'leadin');
  assert.equal(wordPhase(1.1, 1, 2), 'current');
  assert.equal(wordPhase(2, 1, 2), 'sung');
});

test('holdAmount grows with longer notes', () => {
  assert.equal(holdAmount(0.2), 0);
  assert.ok(holdAmount(0.7) > 0 && holdAmount(0.7) < 1);
  assert.equal(holdAmount(2), 1);
});

test('syllableGlow peaks near syllable boundaries', () => {
  // 2 syllables across [0, 1]: boundary at t=0.5
  assert.ok(syllableGlow(0.5, 0, 1, 2) > 0.9);
  assert.ok(syllableGlow(0.25, 0, 1, 2) < 0.5);
  assert.equal(syllableGlow(0.5, 0, 1, 1), 0); // monosyllable
  assert.equal(syllableGlow(0.5, 0, 0.3, 3), 0); // too short
});

test('countInState only fires on real gaps / intro', () => {
  const lines = [
    { start: 0, end: 2 },
    { start: 2.2, end: 4 }, // tight — no count-in
    { start: 7, end: 9 }, // 3s gap — count-in
  ];
  assert.equal(countInState(lines, 1.5, 0), null); // still mid line 0
  assert.equal(countInState(lines, 2.05, 0), null); // tight gap to line 1
  const ci = countInState(lines, 5, 1); // 2s before line 2
  assert.ok(ci);
  assert.equal(ci.idx, 2);
  assert.ok(ci.progress > 0 && ci.progress < 1);
  assert.equal(ci.beat, 2);

  // Intro before first line
  const intro = countInState([{ start: 5, end: 7 }], 3, -1);
  assert.ok(intro);
  assert.equal(intro.idx, 0);
  assert.equal(intro.beat, 2);
});

test('inBreathGap detects pauses between lines', () => {
  const lines = [
    { start: 0, end: 1 },
    { start: 2.5, end: 4 },
  ];
  assert.equal(inBreathGap(lines, 0.5, 1), false);
  assert.equal(inBreathGap(lines, 1.5, 1), true);
  assert.equal(inBreathGap(lines, 2.6, 1), false);
});

test('singer lead is a small fixed cue ahead of true sync', () => {
  assert.ok(SINGER_LEAD >= 0.08 && SINGER_LEAD <= 0.15);
});

test('attackAmount punches at onset then decays', () => {
  assert.equal(attackAmount(0.9, 1), 0);
  assert.ok(attackAmount(1.0, 1) > 0.9);
  assert.ok(attackAmount(1.03, 1) > 0 && attackAmount(1.03, 1) < 1);
  assert.equal(attackAmount(1.1, 1), 0);
});

test('cutAmount is high when the next word is tight', () => {
  assert.equal(cutAmount(0.5), 0);
  assert.ok(cutAmount(0.1) > 0.5);
  assert.equal(cutAmount(0), 1);
});

test('wipeWithCut eases the fill forward on tight follow-ons', () => {
  const mid = 0.5;
  assert.equal(wipeWithCut(mid, 0), mid);
  assert.ok(wipeWithCut(mid, 1) > mid); // progresses faster through the word
});

test('wordLeadIn is longer for hard multi-syllable / held words', () => {
  const easy = wordLeadIn({ text: 'go', start: 0, end: 0.25, syll: 1 });
  const hard = wordLeadIn({ text: 'beautiful', start: 0, end: 0.9, syll: 3 });
  assert.ok(hard > easy);
  assert.ok(easy >= LEADIN_WORD);
});

test('confidenceDim softens low CTC scores and trusts null', () => {
  assert.equal(confidenceDim({ score: null }), 0);
  assert.equal(confidenceDim({}), 0);
  assert.equal(confidenceDim({ score: 0.8 }), 0);
  assert.ok(confidenceDim({ score: 0.1 }) > 0.5);
  assert.equal(confidenceDim({ score: 0 }), 1);
});

test('countInWindowForGap grows for long instrumentals', () => {
  assert.ok(countInWindowForGap(12) > countInWindowForGap(2));
  assert.ok(countInWindowForGap(0) >= 5);
});

test('resolveActiveLine holds through a vocal gap, advances when singing resumes', () => {
  const lines = [
    { start: 0, end: 2 },
    { start: 2.2, end: 4 },
  ];
  assert.equal(resolveActiveLine(lines, 2.5, { prevLi: 0, vocalActive: false }), 0, 'hold in gap');
  assert.equal(resolveActiveLine(lines, 2.5, { prevLi: 0, vocalActive: true }), 1, 'advance when active');
});

test('resolveActiveLine advances immediately on continuous lines', () => {
  const lines = [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ];
  assert.equal(resolveActiveLine(lines, 2.01, { prevLi: 0, vocalActive: true }), 1);
});

test('assignSingers passes the mic at breaths and after long turns', async () => {
  const { assignSingers } = await import('../app/display.js');
  const L = (start, end) => ({ start, end });
  // gap of 3s before line 2 → handoff; 5 back-to-back lines → handoff after 4
  const lines = [L(0, 2), L(2.2, 4), L(7, 9), L(9.1, 10), L(10.1, 11), L(11.1, 12), L(12.1, 13)];
  assert.deepEqual(assignSingers(lines), [0, 0, 1, 1, 1, 1, 0]);
  assert.deepEqual(assignSingers([]), []);
});
