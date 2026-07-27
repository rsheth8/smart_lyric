// Song structure — verse / chorus / instrumental break.
//
// Apple gets this for free: `<div itunes:song-part="Chorus">` is authored into
// the TTML by whoever synced the lyrics. We almost never have that, so when it
// is absent we DERIVE structure from the two signals a lyric timeline already
// carries:
//
//   1. Long gaps between sung lines → instrumental breaks (and intro/outro).
//   2. Repeated blocks of text → the chorus. A block sung more than once is a
//      chorus in essentially every popular song; one sung once is a verse.
//
// Derived sections are marked `derived: true` so the UI can present them with
// less certainty than authored ones. We deliberately do NOT guess at "Bridge",
// "Pre-Chorus", or verse numbering — repetition supports chorus-vs-verse and
// nothing finer, and a confident wrong label is worse than a vague right one.

import { lineSungUntil } from '../../align.js';

/** Silence between sung lines that reads as a block boundary. */
const BLOCK_GAP_SEC = 3.2;
/** Gap long enough to be its own instrumental section on the rail. */
const BREAK_GAP_SEC = 8;
/** Lead-in / run-out worth showing as Intro / Outro. */
const EDGE_SEC = 5;
/** Shorter than this isn't a section, it's a stray line. */
const MIN_SECTION_SEC = 6;

/** A repeated line must be substantial — "oh" and "yeah" recur everywhere. */
const MIN_HOOK_CHARS = 8;
/** A chorus is a repeated PASSAGE; one recurring line is a refrain, not a section. */
const MIN_CHORUS_LINES = 2;

function normalizeLineText(line) {
  return normalizeText((line?.words || []).map((w) => w.text).join(' '));
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Group lines into blocks separated by sung-line gaps.
 * @returns {Array<{ startIdx: number, endIdx: number, start: number, end: number }>}
 */
export function blockify(lines, { gapSec = BLOCK_GAP_SEC } = {}) {
  const sung = (lines || []).filter((l) => l.words?.length);
  if (!sung.length) return [];

  const blocks = [];
  let startIdx = 0;
  for (let i = 1; i <= sung.length; i++) {
    const prev = sung[i - 1];
    const cur = sung[i];
    // Catalog LRC has no true line end (it borrows the next line's start), so
    // the boundary is measured from where the voice actually stops.
    const prevEnd = lineSungUntil(prev);
    const gap = cur ? cur.start - prevEnd : Infinity;
    if (gap >= gapSec || !cur) {
      blocks.push({
        startIdx,
        endIdx: i - 1,
        start: sung[startIdx].start,
        end: prevEnd,
        lines: sung.slice(startIdx, i),
      });
      startIdx = i;
    }
  }
  return blocks;
}

/**
 * Derive song structure from a timeline. Returns contiguous sections covering
 * the song, so a structure rail can render them end to end.
 *
 * @param {{ lines: Array, duration?: number }} timeline
 * @returns {Array<{ part: string, start: number, end: number, derived: true }>}
 */
export function chorusFlags(lines) {
  const keys = lines.map(normalizeLineText);
  const counts = new Map();
  for (const k of keys) {
    if (k.length < MIN_HOOK_CHARS) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  // A line is chorus material when its text recurs...
  const repeated = keys.map((k) => k.length >= MIN_HOOK_CHARS && (counts.get(k) || 0) > 1);

  // ...and it sits in a RUN of such lines. An isolated recurring line is a
  // refrain inside a verse, not a chorus of its own.
  const flags = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!repeated[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && repeated[j]) j++;
    if (j - i >= MIN_CHORUS_LINES) flags.fill(true, i, j);
    i = j;
  }
  return flags;
}

/**
 * Absorb sections too short to be real. A two-second "Verse" wedged between two
 * choruses is a lyric sheet's stray line, not a change of section — and on a
 * structure rail it renders as visual noise a viewer can't act on.
 * Mutates `spans`.
 */
function smoothSlivers(spans, { minSec = MIN_SECTION_SEC } = {}) {
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans.length < 2) break;
    const span = spans[i];
    if (span.end - span.start >= minSec) continue;
    // Only ever merge into a neighbour the sliver actually touches. A short
    // block on the far side of a guitar solo is a real section, however brief —
    // absorbing it across the gap would erase the break along with it.
    const prev = spans[i - 1];
    const next = spans[i + 1];
    const prevAdj = prev && span.start - prev.end < BREAK_GAP_SEC ? prev : null;
    const nextAdj = next && next.start - span.end < BREAK_GAP_SEC ? next : null;
    // Prefer a same-labelled neighbour; otherwise the earlier one.
    const target = prevAdj && (!nextAdj || nextAdj.part !== span.part) ? prevAdj : nextAdj;
    if (!target) continue;
    target.start = Math.min(target.start, span.start);
    target.end = Math.max(target.end, span.end);
    spans.splice(i, 1);
  }
  // Absorbing a sliver can leave two same-labelled neighbours abutting.
  for (let i = spans.length - 1; i > 0; i--) {
    const prev = spans[i - 1];
    if (prev.part !== spans[i].part) continue;
    if (spans[i].start - prev.end >= BREAK_GAP_SEC) continue; // a real gap divides them
    prev.end = Math.max(prev.end, spans[i].end);
    spans.splice(i, 1);
  }
}

export function deriveSections(timeline) {
  const lines = (timeline?.lines || []).filter((l) => l.words?.length);
  if (lines.length < 4) return []; // too short to have structure worth showing

  const chorus = chorusFlags(lines);

  // Walk the lines, cutting a new section when the label changes or a real
  // instrumental gap separates them.
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const part = chorus[i] ? 'Chorus' : 'Verse';
    const prev = spans[spans.length - 1];
    const gapFromPrev = prev ? lines[i].start - prev.end : 0;
    if (prev && prev.part === part && gapFromPrev < BREAK_GAP_SEC) {
      prev.end = lineSungUntil(lines[i]);
    } else {
      spans.push({ part, start: lines[i].start, end: lineSungUntil(lines[i]) });
    }
  }
  smoothSlivers(spans);
  if (spans.length < 2) return []; // one undifferentiated block — nothing to show

  const duration = Number.isFinite(timeline?.duration) && timeline.duration > 0
    ? timeline.duration
    : spans[spans.length - 1].end;

  const sections = [];
  const push = (part, start, end) => {
    if (end - start <= 0.01) return;
    sections.push({ part, start, end, derived: true });
  };

  if (spans[0].start >= EDGE_SEC) push('Intro', 0, spans[0].start);
  for (let i = 0; i < spans.length; i++) {
    const next = spans[i + 1];
    const gap = next ? next.start - spans[i].end : 0;
    // Breathing room between two adjacent sections belongs to the earlier one.
    // Leaving it as a hole makes the rail look broken and blanks the section
    // label every time the playhead crosses a crack.
    const end = next && gap < BREAK_GAP_SEC ? next.start : spans[i].end;
    push(spans[i].part, spans[i].start, end);
    if (next && gap >= BREAK_GAP_SEC) push('Break', spans[i].end, next.start);
  }
  const lastEnd = spans[spans.length - 1].end;
  if (duration - lastEnd >= EDGE_SEC) push('Outro', lastEnd, duration);

  return sections;
}

/**
 * Structure for a timeline: authored sections win, derived ones fill in.
 * @returns {Array<{ part: string, start: number, end: number, derived?: boolean }>}
 */
export function resolveSections(timeline) {
  if (timeline?.sections?.length) return timeline.sections;
  return deriveSections(timeline);
}

/**
 * Index of the section containing `t`, or -1. Sections are ordered and
 * non-overlapping, so a linear scan from a hint is effectively O(1) per frame.
 */
export function sectionIndexAt(sections, t, hint = 0) {
  if (!sections?.length || !Number.isFinite(t)) return -1;
  const start = Math.max(0, Math.min(hint, sections.length - 1));
  if (t >= sections[start].start && t < sections[start].end) return start;
  for (let i = 0; i < sections.length; i++) {
    if (t >= sections[i].start && t < sections[i].end) return i;
  }
  return -1;
}
