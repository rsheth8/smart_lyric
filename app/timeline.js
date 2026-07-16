// Canonical lyric timeline shape consumed by Display and SongSession.
// All format parsers normalize to this structure.

/** @typedef {{ text: string, start: number, end: number, el?: HTMLElement }} TimelineWord */
/** @typedef {{ start: number, end: number, words: TimelineWord[], el?: HTMLElement }} TimelineLine */
/** @typedef {{ lines: TimelineLine[], duration: number }} Timeline */

export function emptyTimeline() {
  return { lines: [], duration: 0 };
}

export function validateTimeline(timeline) {
  if (!timeline || !Array.isArray(timeline.lines)) return false;
  return timeline.lines.every(
    (l) =>
      typeof l.start === 'number' &&
      typeof l.end === 'number' &&
      Array.isArray(l.words) &&
      l.words.every((w) => typeof w.text === 'string' && typeof w.start === 'number')
  );
}
