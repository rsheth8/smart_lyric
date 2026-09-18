// Build a Display timeline from Whisper-style timestamped ASR chunks.

import { tokenizeLine, wordsAcrossSpan } from './estimate.js';
import { normalizeTranscriptText, splitLongSentence } from '../../lib/transcript-text.mjs';

const MAX_LINE_CHARS = 44;

/**
 * @param {Array<{ text?: string, timestamp?: [number, number|null] }>} chunks
 * @param {{ offsetSec?: number, maxLineChars?: number }} [opts]
 *   `offsetSec` shifts ASR times into song time (capture started mid-track).
 */
export function chunksToTimeline(chunks, { offsetSec = 0, maxLineChars = MAX_LINE_CHARS } = {}) {
  const lines = [];
  const list = Array.isArray(chunks) ? chunks : [];

  for (const chunk of list) {
    const text = normalizeTranscriptText(chunk?.text || '');
    if (!text) continue;
    const ts = chunk.timestamp;
    const rawStart = Array.isArray(ts) ? Number(ts[0]) : NaN;
    const rawEnd = Array.isArray(ts) ? Number(ts[1]) : NaN;
    if (!Number.isFinite(rawStart)) continue;
    const start = Math.max(0, rawStart + offsetSec);
    let end = Number.isFinite(rawEnd)
      ? rawEnd + offsetSec
      : start + Math.max(1.2, text.split(/\s+/).length * 0.35);
    if (!(end > start)) end = start + 1.2;

    const pieces = splitLongSentence(text, maxLineChars);
    if (pieces.length <= 1) {
      const tokens = tokenizeLine(text);
      lines.push({ start, end, words: wordsAcrossSpan(tokens, start, end) });
      continue;
    }
    const span = end - start;
    const weights = pieces.map((p) => Math.max(1, p.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let t = start;
    pieces.forEach((piece, i) => {
      const dur = (weights[i] / total) * span;
      const lineEnd = i === pieces.length - 1 ? end : t + dur;
      const tokens = tokenizeLine(piece);
      lines.push({ start: t, end: lineEnd, words: wordsAcrossSpan(tokens, t, lineEnd) });
      t = lineEnd;
    });
  }

  if (!lines.length) return { lines: [], duration: 0, estimated: true, asrTimed: false };
  return {
    lines,
    duration: lines[lines.length - 1].end,
    estimated: true,
    asrTimed: true,
  };
}

/**
 * Replace each timeline line's text with a cleaned version, keeping the line's
 * start/end and re-spreading words across the same span. 1:1 mapping required.
 * @returns {boolean} true when applied.
 */
export function applyCleanedLineTexts(timeline, cleanedLines) {
  const lines = timeline?.lines;
  if (!Array.isArray(lines) || !Array.isArray(cleanedLines)) return false;
  if (lines.length !== cleanedLines.length) return false;

  lines.forEach((line, i) => {
    const text = String(cleanedLines[i] || '').trim();
    if (!text) return; // keep the original words for empty replacements
    const tokens = tokenizeLine(text);
    if (!tokens.length) return;
    line.words = wordsAcrossSpan(tokens, line.start, line.end);
  });
  return true;
}
