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

function parseKaraokeWords(text, lineStart) {
  const words = [];
  const re = /\\k(\d+)([^{\\]*)/g;
  let m;
  let t = lineStart;
  while ((m = re.exec(text)) !== null) {
    const centis = parseInt(m[1], 10);
    const dur = centis / 100;
    const raw = m[2].trim();
    if (!raw) continue;
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      words.push({ text: token, start: t, end: t + dur });
      t += dur;
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
    const karaokeWords = parseKaraokeWords(body, start);
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
