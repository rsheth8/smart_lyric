// LRC parsing → canonical timeline with line and (interpolated) word timings.

import { wordsAcrossSpan } from './estimate.js';

// Estimate a word's syllable count — a much better proxy for how long it's sung
// than raw character length (the previous heuristic). Vowel *groups* ≈ syllables
// for Latin/romanized text; for non-Latin scripts (CJK, Devanagari, …) each
// letter is roughly one mora, so letter count is the better estimate.
const LATIN_RE = /[a-z]/i;
export function syllableCount(word) {
  const w = (word || '').toLowerCase();
  if (LATIN_RE.test(w)) {
    let n = (w.match(/[aeiouyàáâäãåèéêëìíîïòóôöõùúûüỳýŷÿ]+/g) || []).length;
    // Drop a silent trailing "e" (e.g. "time" → 1, not 2).
    if (n > 1 && /[^aeiou]e\b/.test(w)) n -= 1;
    return Math.max(1, n);
  }
  const letters = [...w].filter((c) => /\p{L}/u.test(c)).length;
  return Math.max(1, letters);
}

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

    let words;
    if (line.wordTimes && line.wordTimes.length === tokens.length) {
      words = tokens.map((text, wi) => ({
        text,
        start: line.wordTimes[wi],
        end: wi + 1 < line.wordTimes.length ? line.wordTimes[wi + 1] : end,
      }));
    } else {
      // No per-word timestamps: estimate them. Shared with the plain/estimated and
      // ASR paths so every "words estimated" source uses one corrected model.
      words = wordsAcrossSpan(tokens, line.start, end);
    }
    return { start: line.start, end, words };
  });

  return { lines, duration: lines[lines.length - 1].end };
}
