import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWordSpans,
  fitToOnsets,
  secPerWeight,
  wordWeight,
  GAP_TOLERANCE_SEC,
} from '../app/word-spans.js';

// applyWordSpans is what stands between the CTC model and the screen. It used to
// be reachable only through refineTimelineWithAudio (fake window.bar4bar, fake
// PCM, batching), which made its behaviour expensive to pin down and impossible
// to measure. These tests drive it directly.

/** A line with `n` words evenly spread across [start,end) — the pre-align state. */
function line(start, end, texts) {
  const span = (end - start) / texts.length;
  return {
    start,
    end,
    words: texts.map((text, i) => ({
      text,
      start: start + i * span,
      end: start + (i + 1) * span,
    })),
  };
}

/** Spans as the aligner emits them: window-relative, one slot per word. */
function spans(list) {
  return list.map((s) => (s == null ? null : { start: s[0], end: s[1], score: s[2] ?? 0.9 }));
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ---- re-anchoring (step 2) --------------------------------------------------

test('anchors the line to the first confident vocal onset, not the catalog start', () => {
  const l = line(10, 14, ['a', 'b', 'c', 'd']);
  const ok = applyWordSpans(l, spans([[0.5, 0.9], [1.5, 1.9], [2.5, 2.9], [3.5, 3.9]]), {
    offsetSec: 10,
  });
  assert.equal(ok, true);
  assert.ok(near(l.start, 10.5), `line.start ${l.start}`);
  assert.ok(near(l.words[0].start, 10.5));
});

test('back-extrapolates to word 0 when the first ANCHOR is a later word', () => {
  // Soft consonants score low, so CTC's first confident word is often word 2 or
  // 3. Anchoring the line there is the "late off the jump" bug.
  const l = line(10, 14, ['a', 'b', 'c']);
  applyWordSpans(l, spans([[0, 0, 0.1], [2.0, 2.4], [3.0, 3.4]]), { offsetSec: 10 });
  // pace = 1.0s across one word of weight 1.4 → 0.714, clamped to 0.5;
  // lead weight 1.4 → back 0.7s before the 12.0 anchor.
  assert.ok(near(l.start, 11.3), `expected back-extrapolation to 11.3, got ${l.start}`);
  assert.ok(l.start < 12.0, 'must start before the first anchor');
});

test('back-extrapolation is capped — a slow pace cannot drag the line far back', () => {
  const l = line(10, 14, ['a', 'b', 'c', 'd']);
  applyWordSpans(l, spans([[0, 0, 0.1], [0, 0, 0.1], [2.0, 2.4], [3.0, 3.4]]), { offsetSec: 10 });
  // Uncapped this would be 12.0 - 2.8*0.5 = 10.6; MAX_LEAD_EXTRAPOLATION_SEC = 1.2.
  assert.ok(near(l.start, 10.8), `expected the 1.2s cap to bind, got ${l.start}`);
});

test('floorSec keeps a re-anchored line from starting before the previous one ends', () => {
  const l = line(10, 14, ['a', 'b', 'c']);
  applyWordSpans(l, spans([[0, 0, 0.1], [2.0, 2.4], [3.0, 3.4]]), {
    offsetSec: 10,
    floorSec: 11.8, // previous line runs until here
  });
  assert.ok(near(l.start, 11.8), `line.start ${l.start} must be clamped to the floor`);
});

test('nextLineStart caps line.end so two lines are never current at once', () => {
  const l = line(10, 14, ['a', 'b']);
  applyWordSpans(l, spans([[0.5, 1.0], [4.0, 5.0]]), { offsetSec: 10, nextLineStart: 14.5 });
  // The last anchor ends at 15.0, past the next line; the cap wins.
  assert.ok(near(l.end, 14.48), `line.end ${l.end}`);
  assert.ok(l.end < 14.5);
});

// ---- confidence gating (step 1) ---------------------------------------------

test('returns false and leaves timing untouched when nothing is confident', () => {
  const l = line(10, 14, ['a', 'b']);
  const before = l.words.map((w) => ({ ...w }));
  const ok = applyWordSpans(l, spans([[0.5, 1.0, 0.1], [2.0, 2.4, 0.05]]), { offsetSec: 10 });
  assert.equal(ok, false);
  assert.deepEqual(l.words, before);
  assert.equal(l.start, 10);
  assert.equal(l._vocalAligned, undefined);
});

test('a span with no score at all is trusted (older aligners omit it)', () => {
  const l = line(10, 14, ['a', 'b']);
  const ok = applyWordSpans(l, [{ start: 0.5, end: 1.0 }, { start: 2.0, end: 2.4 }], {
    offsetSec: 10,
  });
  assert.equal(ok, true);
  assert.equal(l.words[0].score, 1);
});

test('minScore is honoured — a stem run trusts words the raw mix would drop', () => {
  const l = line(10, 14, ['a', 'b']);
  const low = spans([[0.5, 1.0, 0.2], [2.0, 2.4, 0.2]]);
  assert.equal(applyWordSpans(line(10, 14, ['a', 'b']), low, { offsetSec: 10 }), false);
  assert.equal(applyWordSpans(l, low, { offsetSec: 10, minScore: 0.15 }), true);
});

test('interpolated words carry score 0; anchors carry the CTC score', () => {
  const l = line(10, 14, ['a', 'b', 'c']);
  applyWordSpans(l, spans([[0.5, 0.9, 0.8], [0, 0, 0.1], [3.0, 3.4, 0.7]]), { offsetSec: 10 });
  assert.equal(l.words[0].score, 0.8);
  assert.equal(l.words[1].score, 0);
  assert.equal(l.words[2].score, 0.7);
});

test('a mostly-interpolated line is flagged uncertain for line-level display', () => {
  const l = line(10, 20, ['a', 'b', 'c', 'd', 'e']);
  applyWordSpans(l, spans([[0.5, 0.9], null, null, null, null]), { offsetSec: 10 });
  assert.ok(near(l._alignCoverage, 0.2));
  assert.equal(l.uncertain, true);
});

test('a line at exactly the coverage threshold is NOT uncertain', () => {
  const l = line(10, 20, ['a', 'b', 'c', 'd', 'e']);
  applyWordSpans(l, spans([[0.5, 0.9], [2.0, 2.4], null, [6.0, 6.4], null]), { offsetSec: 10 });
  assert.ok(near(l._alignCoverage, 0.6));
  assert.equal(l.uncertain, false);
});

// ---- placement (steps 3-4) --------------------------------------------------

test('word starts are strictly increasing even when CTC emits them out of order', () => {
  const l = line(10, 14, ['a', 'b', 'c']);
  applyWordSpans(l, spans([[2.0, 2.4], [1.0, 1.4], [3.0, 3.4]]), { offsetSec: 10 });
  for (let i = 1; i < l.words.length; i++) {
    assert.ok(
      l.words[i].start > l.words[i - 1].start,
      `word ${i} start ${l.words[i].start} <= ${l.words[i - 1].start}`
    );
  }
});

test('every word start is passed through snap()', () => {
  const l = line(10, 14, ['a', 'b', 'c']);
  const seen = [];
  applyWordSpans(l, spans([[0.5, 0.9], [1.5, 1.9], [2.5, 2.9]]), {
    offsetSec: 10,
    snap: (t) => {
      seen.push(t);
      return t;
    },
  });
  assert.equal(seen.length, 3);
});

test('interpolated words land on observed syllable attacks when the stem shows them', () => {
  const l = line(10, 14, ['a', 'b', 'c', 'd']);
  applyWordSpans(l, spans([[0, 0.2], null, null, [3.0, 3.5]]), {
    offsetSec: 10,
    onsetsIn: () => [11.0, 12.5], // where the voice really moved
  });
  assert.ok(near(l.words[1].start, 11.0), `got ${l.words[1].start}`);
  assert.ok(near(l.words[2].start, 12.5), `got ${l.words[2].start}`);
});

test('too few attacks to explain every word → keep the even spread, never guess', () => {
  const l = line(10, 14, ['a', 'b', 'c', 'd']);
  applyWordSpans(l, spans([[0, 0.2], null, null, [3.0, 3.5]]), {
    offsetSec: 10,
    onsetsIn: () => [11.4], // one attack, two unknown words
  });
  assert.ok(near(l.words[1].start, 10.2), `got ${l.words[1].start}`);
});

// ---- word ends (step 5) -----------------------------------------------------

test('a word before a real pause ends when CTC says it ended, not at the next word', () => {
  const l = line(10, 14, ['a', 'b']);
  applyWordSpans(l, spans([[0, 0.6], [2.0, 2.5]]), { offsetSec: 10 });
  assert.ok(near(l.words[0].end, 10.6), `got ${l.words[0].end} — should not fake a 1.4s hold`);
  assert.ok(near(l.words[1].end, 12.5), 'the last word should not stretch to line.end either');
});

test('a small gap still stretches to the next word so the wipe stays continuous', () => {
  const l = line(10, 14, ['a', 'b']);
  const gap = GAP_TOLERANCE_SEC / 2;
  applyWordSpans(l, spans([[0, 0.6], [0.6 + gap, 1.4]]), { offsetSec: 10 });
  assert.ok(near(l.words[0].end, l.words[1].start), `${l.words[0].end} vs ${l.words[1].start}`);
});

test('where the voice actually stops beats the CTC end (a held note keeps its length)', () => {
  const l = line(10, 14, ['a', 'b']);
  applyWordSpans(l, spans([[0, 0.6], [2.0, 2.5]]), {
    offsetSec: 10,
    // CTC under-measures a sustained vowel; the stem says it rang on to 11.5.
    voiceEndIn: (from) => (near(from, 10.0) ? 11.5 : from + 0.2),
  });
  assert.ok(near(l.words[0].end, 11.5), `got ${l.words[0].end}`);
});

test('word ends never invert', () => {
  const l = line(10, 14, ['a', 'b']);
  applyWordSpans(l, spans([[0, 0.6], [2.0, 2.5]]), {
    offsetSec: 10,
    voiceEndIn: (from) => from - 5, // pathological detector
  });
  for (const w of l.words) assert.ok(w.end > w.start, `${w.text}: ${w.start}→${w.end}`);
});

// ---- guards -----------------------------------------------------------------

test('no-ops on a wordless line, empty spans, or a non-array', () => {
  assert.equal(applyWordSpans({ start: 0, end: 1, words: [] }, spans([[0, 1]])), false);
  assert.equal(applyWordSpans(line(0, 1, ['a']), []), false);
  assert.equal(applyWordSpans(line(0, 1, ['a']), null), false);
  assert.equal(applyWordSpans(null, spans([[0, 1]])), false);
});

test('line.end stays after line.start on a degenerate line', () => {
  const l = line(10, 10.05, ['a']);
  applyWordSpans(l, spans([[0, 0.02]]), { offsetSec: 10 });
  assert.ok(l.end > l.start, `${l.start}→${l.end}`);
});

// ---- helpers ----------------------------------------------------------------

test('wordWeight scales with syllables and never reaches zero', () => {
  assert.ok(wordWeight({ text: 'hello' }) > wordWeight({ text: 'a' }));
  assert.ok(wordWeight({ text: '' }) > 0);
  assert.ok(wordWeight(null) > 0);
});

test('secPerWeight measures the observed pace between the outer anchors', () => {
  const words = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  const anchors = [
    { i: 0, start: 10 },
    { i: 2, start: 12.8 },
  ];
  // 2.8s across weights 1.4 + 1.4 → 1.0 s per weight unit.
  assert.ok(near(secPerWeight(words, anchors, 10, 14), 0.5), 'clamped to SEC_PER_WEIGHT_MAX');
  const slow = [
    { i: 0, start: 10 },
    { i: 2, start: 10.56 },
  ];
  assert.ok(near(secPerWeight(words, slow, 10, 14), 0.2));
});

test('secPerWeight falls back to the catalog line span with a single anchor', () => {
  const words = [{ text: 'a' }, { text: 'b' }];
  // One anchor → no observed pace; 2.8s of line across weight 2.8 → 1.0, clamped.
  assert.ok(near(secPerWeight(words, [{ i: 0, start: 10 }], 10, 12.8), 0.5));
});

test('fitToOnsets keeps order and never invents placement from too little evidence', () => {
  assert.deepEqual(fitToOnsets([1, 2], [], 0, 5), [1, 2]);
  assert.deepEqual(fitToOnsets([1, 2], [1.5], 0, 5), [1, 2]);
  // Melisma: more attacks than words → pick the best n, in order.
  const out = fitToOnsets([1, 3], [0.9, 1.6, 2.2, 3.1], 0, 5);
  assert.equal(out.length, 2);
  assert.ok(out[0] < out[1]);
  assert.ok(near(out[0], 0.9) && near(out[1], 3.1));
});
