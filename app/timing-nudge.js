// Human timing nudge — shift a word or a whole line on the timeline.
//
// Unlike syncOffset (speaker/output latency for the whole song), these edits
// reshape the karaoke asset itself: absolute word start/end times, persisted
// through the alignment sidecar so the next play keeps the correction.
//
// Pure: no DOM, no Electron. Callers mark `_humanNudged` / `_vocalAligned` and
// save via `session.saveAlignedCache()`.

/** Keep a finite number; fall back when the input is garbage. */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Shift one word's start/end by `deltaSec`, keeping order with its neighbors.
 * May shrink the word slightly when neighbors leave little room. Edge words may
 * stretch the line anchors. Mutates in place.
 * @returns {{ start: number, end: number }|null} new span, or null if no-op
 */
export function nudgeWord(line, wordIndex, deltaSec) {
  if (!line?.words?.length) return null;
  const i = Number(wordIndex);
  if (!Number.isInteger(i) || i < 0 || i >= line.words.length) return null;
  const d = Number(deltaSec);
  if (!Number.isFinite(d) || d === 0) return null;

  const MIN_DUR = 0.04;
  const GAP = 0.01;
  const w = line.words[i];
  const prevEnd = i > 0 ? num(line.words[i - 1].end, line.words[i - 1].start) + GAP : -Infinity;
  const nextStart =
    i < line.words.length - 1
      ? num(line.words[i + 1].start, line.words[i + 1].end) - GAP
      : Infinity;

  if (!(nextStart - prevEnd >= MIN_DUR)) return null;

  let start = Math.max(prevEnd, Math.min(nextStart - MIN_DUR, num(w.start) + d));
  let end = Math.max(start + MIN_DUR, Math.min(nextStart, num(w.end) + d));
  if (Math.abs(start - num(w.start)) < 1e-9 && Math.abs(end - num(w.end)) < 1e-9) return null;

  w.start = start;
  w.end = end;
  w._humanNudged = true;

  const first = line.words[0];
  const last = line.words[line.words.length - 1];
  line.start = Math.min(num(line.start, first.start), first.start);
  line.end = Math.max(num(line.end, last.end), last.end);
  return { start: w.start, end: w.end };
}

/**
 * Shift every word on a line (and the line anchors) by `deltaSec`, clamped so
 * the line doesn't cross the previous/next line. Mutates in place.
 * @returns {{ start: number, end: number }|null}
 */
export function nudgeLine(line, deltaSec, { prevEnd = null, nextStart = null } = {}) {
  if (!line?.words?.length) return null;
  const d = Number(deltaSec);
  if (!Number.isFinite(d) || d === 0) return null;

  const GAP = 0.02;
  const floor = prevEnd != null && Number.isFinite(prevEnd) ? prevEnd + GAP : -Infinity;
  const ceil = nextStart != null && Number.isFinite(nextStart) ? nextStart - GAP : Infinity;
  const dur = Math.max(0.05, num(line.end, line.start + 1) - num(line.start));

  let start = num(line.start) + d;
  start = Math.max(floor, start);
  start = Math.min(start, ceil - dur);
  if (!Number.isFinite(start)) return null;

  const applied = start - num(line.start);
  if (Math.abs(applied) < 1e-9) return null;

  line.start = start;
  line.end = start + dur;
  for (const w of line.words) {
    w.start = num(w.start) + applied;
    w.end = num(w.end) + applied;
    w._humanNudged = true;
  }
  if (line.bg?.length) {
    for (const g of line.bg) {
      if (g.start != null) g.start = num(g.start) + applied;
      if (g.end != null) g.end = num(g.end) + applied;
      for (const w of g.words || []) {
        w.start = num(w.start) + applied;
        w.end = num(w.end) + applied;
      }
    }
  }
  line._humanNudged = true;
  return { start: line.start, end: line.end };
}

/**
 * Nudge the active word or line on a timeline.
 * @param {'word'|'line'} scope
 * @returns {{ scope: string, lineIndex: number, wordIndex?: number, deltaSec: number }|null}
 */
export function nudgeTimeline(timeline, { scope = 'word', lineIndex, wordIndex = 0, deltaSec } = {}) {
  if (!timeline?.lines?.length) return null;
  const li = Number(lineIndex);
  if (!Number.isInteger(li) || li < 0 || li >= timeline.lines.length) return null;
  const line = timeline.lines[li];

  if (scope === 'line') {
    const prevEnd = li > 0 ? timeline.lines[li - 1].end : null;
    const nextStart = li < timeline.lines.length - 1 ? timeline.lines[li + 1].start : null;
    const res = nudgeLine(line, deltaSec, { prevEnd, nextStart });
    if (!res) return null;
    line._vocalAligned = true;
    line._humanNudged = true;
    timeline.humanEdited = true;
    return { scope: 'line', lineIndex: li, deltaSec: Number(deltaSec) };
  }

  const res = nudgeWord(line, wordIndex, deltaSec);
  if (!res) return null;
  line._vocalAligned = true;
  line._humanNudged = true;
  timeline.humanEdited = true;
  return { scope: 'word', lineIndex: li, wordIndex: Number(wordIndex), deltaSec: Number(deltaSec) };
}
