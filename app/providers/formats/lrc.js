// LRC parsing → canonical timeline with line and (interpolated) word timings.

const LINE_RE = /^((?:\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\])+)(.*)$/;
const TAG_RE = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
const WORD_TS_RE = /<(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)>/g;

function toSeconds(mm, ss) {
  return parseInt(mm, 10) * 60 + parseFloat(ss);
}

function parseRawLines(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const [, stamps, body] = m;

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

function extractWordTimes(body) {
  const times = [];
  let m;
  WORD_TS_RE.lastIndex = 0;
  while ((m = WORD_TS_RE.exec(body)) !== null) {
    times.push(toSeconds(m[1], m[2]));
  }
  return times;
}

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
      words = tokens.map((text, wi) => ({
        text,
        start: line.wordTimes[wi],
        end: wi + 1 < line.wordTimes.length ? line.wordTimes[wi + 1] : end,
      }));
    } else {
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
