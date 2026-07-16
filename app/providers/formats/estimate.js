// Turn plain (untimed) lyrics into a rough timeline so they still auto-follow.
//
// We have no per-line timing, so we spread the lines across the song's duration.
// This is honestly approximate — the display labels it "estimated" and keeps the
// highlight at the LINE level only (one span per line, no fake per-word sweep,
// which is exactly the thing that felt wrong before).

/** Split plain text into displayable lines, preserving blank lines as spacers. */
export function splitPlainLines(plain) {
  return (plain || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim());
}

/**
 * @param {string} plain
 * @param {{ duration?: number, leadIn?: number, secPerLine?: number }} [opts]
 *   `duration` in seconds spreads lines to fill the song; otherwise falls back to
 *   `secPerLine`. `leadIn` delays the first line (intro).
 * @returns {{ lines: Array, duration: number, estimated: true }}
 */
export function estimateTimeline(plain, { duration, leadIn = 0, secPerLine = 3.4 } = {}) {
  const all = splitPlainLines(plain);
  // Index the sung (non-blank) lines; blanks become gaps, not timeline entries.
  const sung = all.filter((t) => t.length > 0);
  if (!sung.length) return { lines: [], duration: 0, estimated: true };

  const span = duration && duration > leadIn + 1 ? duration - leadIn : sung.length * secPerLine;
  const per = span / sung.length;

  const lines = sung.map((text, i) => {
    const start = leadIn + i * per;
    const end = leadIn + (i + 1) * per;
    return { start, end, words: [{ text, start, end }] };
  });

  return { lines, duration: lines[lines.length - 1].end, estimated: true };
}
