// Advanced SubStation Alpha (ASS) karaoke → canonical timeline.
// Parses Dialogue lines with \k tags for per-syllable timing.

function parseAssTime(ts) {
  const m = ts.trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

function stripAssTags(text) {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, ' ')
    .replace(/\\n/g, ' ')
    .trim();
}

/**
 * Parse ASS karaoke overrides into word spans.
 * `{\k100}hello world` is ONE 1.0s karaoke chunk split across its tokens —
 * not 1.0s per whitespace token, and never with a leftover `}` in the text.
 */
export function parseKaraokeWords(text, lineStart, lineEnd = Infinity) {
  const words = [];
  // {\kN} / {\kfN} / {\koN} then text until the next override block.
  const re = /\{\\k(?:f|o)?(\d+)\}([^{]*)/gi;
  let t = lineStart;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dur = parseInt(m[1], 10) / 100;
    const raw = m[2].replace(/\\N/gi, ' ').replace(/\\n/g, ' ').trim();
    if (!raw) {
      t += dur;
      continue;
    }
    const tokens = raw.split(/\s+/).filter(Boolean);
    const weight = tokens.reduce((s, tok) => s + Math.max(1, tok.length), 0) || 1;
    let remain = dur;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokDur =
        i === tokens.length - 1 ? remain : dur * (Math.max(1, token.length) / weight);
      words.push({ text: token, start: t, end: t + tokDur });
      remain -= tokDur;
      t += tokDur;
    }
  }
  if (!words.length) return words;
  const cap = Number.isFinite(lineEnd) && lineEnd > lineStart ? lineEnd : null;
  if (cap != null) {
    for (const w of words) {
      w.start = Math.min(w.start, cap - 0.02);
      w.end = Math.min(w.end, cap);
      if (!(w.end > w.start)) w.end = w.start + 0.02;
    }
    // Only stretch the last word to the dialogue end when karaoke overran it
    // (or landed essentially on it). Don't invent a held tail to fill unused
    // dialogue span — that belongs to silence / the next line.
    if (words[words.length - 1].end > cap - 0.001) {
      words[words.length - 1].end = cap;
    }
  }
  return words;
}

export function parseASS(ass) {
  const lines = [];
  for (const raw of ass.split(/\r?\n/)) {
    if (!raw.startsWith('Dialogue:')) continue;
    const parts = raw.split(',');
    if (parts.length < 10) continue;
    const start = parseAssTime(parts[1]);
    const end = parseAssTime(parts[2]);
    const body = parts.slice(9).join(',').trim();
    const karaokeWords = parseKaraokeWords(body, start, end);
    const plain = stripAssTags(body);
    if (!plain) continue;

    if (karaokeWords.length) {
      lines.push({ start, end, words: karaokeWords });
    } else {
      const tokens = plain.split(/\s+/).filter(Boolean);
      const span = Math.max(0.001, end - start);
      const step = span / Math.max(1, tokens.length);
      lines.push({
        start,
        end,
        words: tokens.map((text, i) => ({
          text,
          start: start + i * step,
          end: start + (i + 1) * step,
        })),
      });
    }
  }

  lines.sort((a, b) => a.start - b.start);
  const duration = lines.length ? lines[lines.length - 1].end : 0;
  return { lines, duration };
}
