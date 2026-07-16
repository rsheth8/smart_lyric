// NetEase "yrc" word-level karaoke format → canonical timeline.
//
// Each sung line looks like:
//   [lineStartMs,lineDurMs](wStartMs,wDurMs,0)Word (wStartMs,wDurMs,0)next ...
// Metadata lines are JSON objects ({"t":..,"c":[..]}) and are skipped.
//
// Unlike LRCLIB line-level lyrics, every word carries a real start/end sampled
// from the vocal, so the highlight tracks the actual beat instead of an even sweep.

const LINE_RE = /^\[(\d+),(\d+)\]/;
const WORD_RE = /\((\d+),(\d+),\d+\)([^(\n]*)/g;

export function parseYRC(yrc, { trailingLineSeconds = 4 } = {}) {
  const lines = [];
  for (const raw of (yrc || '').split(/\r?\n/)) {
    const header = raw.match(LINE_RE);
    if (!header) continue; // skip JSON metadata / blank lines

    const words = [];
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(raw)) !== null) {
      const start = parseInt(m[1], 10) / 1000;
      const dur = parseInt(m[2], 10) / 1000;
      const text = m[3];
      if (!text.trim()) continue; // spacing-only token — fold into previous word's gap
      words.push({ text: text.trim(), start, end: start + dur });
    }
    if (!words.length) continue;

    const lineStart = parseInt(header[1], 10) / 1000;
    const lineDur = parseInt(header[2], 10) / 1000;
    const lineEnd = Math.max(lineStart + lineDur, words[words.length - 1].end);
    lines.push({ start: lineStart, end: lineEnd, words });
  }

  if (!lines.length) return { lines: [], duration: 0 };

  // A word's highlight should hold until the next word begins (avoids flicker on
  // short durations); clamp each word's end up to the following word's start.
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].words;
    for (let j = 0; j < w.length - 1; j++) {
      if (w[j].end < w[j + 1].start) w[j].end = w[j + 1].start;
    }
    const last = w[w.length - 1];
    const nextLine = lines[i + 1];
    lines[i].end = nextLine ? Math.min(lines[i].end, nextLine.start) : last.end + trailingLineSeconds;
    if (last.end < lines[i].end) last.end = lines[i].end;
  }

  return { lines, duration: lines[lines.length - 1].end };
}
