// Helpers for turning speech-to-text output into lyric-like plain text.
// Keep this pure so tests can cover formatting without loading a speech model.

const MAX_LINE_CHARS = 44;

export function normalizeTranscriptText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

export function splitLongSentence(sentence, maxChars = MAX_LINE_CHARS) {
  const words = String(sentence || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function transcriptToPlainLyrics(text, { maxLineChars = MAX_LINE_CHARS } = {}) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return '';

  const sentences = normalized
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const lines = [];
  for (const sentence of sentences) {
    lines.push(...splitLongSentence(sentence, maxLineChars));
  }
  return lines.join('\n');
}
