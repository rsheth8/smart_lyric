// Turn plain (untimed) lyrics into a rough timeline so they still auto-follow.
//
// Without vocal audio we only have duration — lines are spread evenly, and words
// inside a line use syllable weights (same heuristic as LRC). Forced alignment
// later rewrites those word starts/ends from the real vocal when audio exists.

import { syllableCount } from './lrc.js';

/** Split plain text into displayable lines, preserving blank lines as spacers. */
export function splitPlainLines(plain) {
  return (plain || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim());
}

/** Tokenize a lyric line into display/align words. */
export function tokenizeLine(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Natural sung pace (syllables/sec) and how much even-stretch to keep. Without
// real vocal timing we can't know a word's true duration, but stretching every
// word to fill the line span is the worst assumption: it sprints through held
// notes and pushes silence/instrumental gaps back onto the words. Instead we
// onset-PACK words at a natural rate from line.start and let the leftover span
// fall on the final word as a held tail. Scored against real word-level (yrc)
// ground truth over 286 lines, this cut per-word START error median 290→227ms,
// worst case 10.1s→5.6s, with no metric regressing. The small STRETCH_BLEND
// keeps a little even-spread so genuinely slow, evenly-sung lines don't skew too
// early. Values are empirically tuned; revisit if more ground truth is added.
const NATURAL_SYLL_PER_SEC = 4;
const STRETCH_BLEND = 0.3; // 0 = pure onset-pack, 1 = old even stretch

/**
 * Estimate per-word timing across a line span [start, end). Words are packed at
 * a natural syllable rate from `start` (blended slightly toward an even spread);
 * the final word holds to `end` so a trailing held note / gap isn't smeared
 * across the whole line. Used wherever true per-word timing is unavailable.
 */
export function wordsAcrossSpan(tokens, start, end) {
  const span = Math.max(0.001, end - start);
  if (!tokens.length) return [];
  if (tokens.length === 1) return [{ text: tokens[0], start, end }];
  const weights = tokens.map((t) => 0.4 + syllableCount(t));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  // Onset-pack: each word wants ~weight/rate seconds. Only compress (never
  // stretch) when natural delivery overflows the span — e.g. a fast/rap line.
  const natural = weights.map((w) => w / NATURAL_SYLL_PER_SEC);
  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  const scale = naturalTotal > span ? span / naturalTotal : 1;

  // Blend the packed start with the even-stretch start (both monotonic).
  const starts = [];
  let packedT = start;
  let evenT = start;
  for (let i = 0; i < tokens.length; i++) {
    starts.push(packedT * (1 - STRETCH_BLEND) + evenT * STRETCH_BLEND);
    packedT += natural[i] * scale;
    evenT += (weights[i] / total) * span;
  }
  // Each word holds until the next word's start; the last word holds to line end.
  return tokens.map((text, i) => ({
    text,
    start: starts[i],
    end: i + 1 < starts.length ? starts[i + 1] : end,
  }));
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
    const tokens = tokenizeLine(text);
    return { start, end, words: wordsAcrossSpan(tokens, start, end) };
  });

  return { lines, duration: lines[lines.length - 1].end, estimated: true };
}
