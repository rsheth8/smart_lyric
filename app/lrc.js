// LRC parsing → a timeline of lines and (interpolated) word timings.
//
// LRCLIB and most synced-lyric sources give LINE-level timing:
//   [00:12.34] Drop the needle, let the evening start
// We want WORD-level highlighting. Word timestamps are rare, so when they're
// absent we distribute a line's words evenly across its duration (this line's
// start → next line's start). That yields a smooth karaoke sweep from plain LRC.

const LINE_RE = /^((?:\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\])+)(.*)$/;
const TAG_RE = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
// Enhanced/word-level LRC uses inline <mm:ss.xx> before each word.
const WORD_TS_RE = /<(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)>/g;

function toSeconds(mm, ss) {
  return parseInt(mm, 10) * 60 + parseFloat(ss);
}

// Parse raw LRC text into ordered line objects: { start, text, wordTimes? }.
function parseRawLines(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const [, stamps, body] = m;

    // A line can carry multiple timestamps (repeated chorus) — emit one per stamp.
    let tagMatch;
    TAG_RE.lastIndex = 0;
    const starts = [];
    while ((tagMatch = TAG_RE.exec(stamps)) !== null) {
      starts.push(toSeconds(tagMatch[1], tagMatch[2]));
    }

    const text = body.replace(WORD_TS_RE, '').trim();
    const wordTimes = extractWordTimes(body);
    for (const start of starts) {
      out.push({ start, text, wordTimes: wordTimes.length ? wordTimes : null });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Pull inline <mm:ss.xx> word timestamps if the file is enhanced LRC.
function extractWordTimes(body) {
  const times = [];
  let m;
  WORD_TS_RE.lastIndex = 0;
  while ((m = WORD_TS_RE.exec(body)) !== null) {
    times.push(toSeconds(m[1], m[2]));
  }
  return times;
}

// Build the final timeline the display consumes.
// Each line: { start, end, words:[{ text, start, end }] }
export function parseLRC(lrc, { trailingLineSeconds = 4 } = {}) {
  const rawLines = parseRawLines(lrc).filter((l) => l.text.length > 0);
  if (!rawLines.length) return { lines: [], duration: 0 };

  const lines = rawLines.map((line, i) => {
    const next = rawLines[i + 1];
    const end = next ? next.start : line.start + trailingLineSeconds;
    const tokens = line.text.split(/\s+/).filter(Boolean);
    const span = Math.max(0.001, end - line.start);

    let words;
    if (line.wordTimes && line.wordTimes.length === tokens.length) {
      // True per-word timing available.
      words = tokens.map((text, wi) => ({
        text,
        start: line.wordTimes[wi],
        end: wi + 1 < line.wordTimes.length ? line.wordTimes[wi + 1] : end,
      }));
    } else {
      // Interpolate: weight each word's duration by its length so long words
      // hold a touch longer — reads more naturally than a flat split.
      const weights = tokens.map((t) => 0.5 + t.replace(/[^\p{L}\p{N}]/gu, '').length);
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      let t = line.start;
      words = tokens.map((text, wi) => {
        const dur = (weights[wi] / total) * span;
        const w = { text, start: t, end: t + dur };
        t += dur;
        return w;
      });
    }
    return { start: line.start, end, words };
  });

  return { lines, duration: lines[lines.length - 1].end };
}
