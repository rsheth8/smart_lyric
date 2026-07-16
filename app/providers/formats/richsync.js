// Musixmatch "richsync" word-level karaoke → canonical timeline.
//
// richsync_body is a JSON array of line entries:
//   { ts, te, x, l: [{ c: "chunk", o: offsetFromTs }, …] }
// ts = line start (s), te = line end (s), each chunk's absolute start = ts + o.
// Space-only chunks are gaps between words.
//
// Caveat: richsync quality is inconsistent — some lines have all word offsets
// crammed into a fraction of a second (`te` ≈ `ts`) even though the line really
// spans seconds. We detect those degenerate lines and fall back to syllable
// interpolation so they don't flash by; good lines keep their real vocal timing.

import { syllableCount } from './lrc.js';

function interpolateBySyllable(words, start, end) {
  const span = Math.max(0.001, end - start);
  const weights = words.map((w) => 0.4 + syllableCount(w.text));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return words.map((w, i) => {
    const dur = (weights[i] / total) * span;
    const out = { text: w.text, start: t, end: t + dur };
    t += dur;
    return out;
  });
}

export function parseRichsync(body, { trailingLineSeconds = 4 } = {}) {
  let entries;
  try {
    entries = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return { lines: [], duration: 0 };
  }
  if (!Array.isArray(entries) || !entries.length) return { lines: [], duration: 0 };
  entries.sort((a, b) => a.ts - b.ts);

  const lines = entries.map((e, i) => {
    const start = e.ts;
    const next = entries[i + 1];
    // Hold each line until the next begins (smoother than the often-early `te`).
    const end = next ? next.ts : Math.max(e.te || start, start + trailingLineSeconds);

    let words = [];
    for (const chunk of e.l || []) {
      const text = (chunk.c || '').trim();
      if (!text) continue; // spacing-only chunk
      words.push({ text, start: start + (chunk.o || 0) });
    }
    if (!words.length) {
      words = [{ text: (e.x || '').trim(), start, end }];
    } else {
      for (let k = 0; k < words.length; k++) {
        words[k].end = k + 1 < words.length ? words[k + 1].start : end;
      }
    }

    // Degenerate line: word offsets barely advance across a multi-second line.
    const maxOffset = words[words.length - 1].start - start;
    const span = end - start;
    if (words.length > 1 && span > 1.5 && maxOffset < 0.4 * span) {
      words = interpolateBySyllable(words, start, end);
    }

    return { start, end, words };
  });

  return { lines, duration: lines[lines.length - 1].end };
}
