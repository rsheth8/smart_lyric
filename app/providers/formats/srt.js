// SubRip (SRT) → canonical timeline. Word timings interpolated per cue.

function parseTimestamp(ts) {
  const m = ts.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

function interpolateWords(text, start, end) {
  const tokens = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(0.001, end - start);
  const weights = tokens.map((t) => 0.5 + t.replace(/[^\p{L}\p{N}]/gu, '').length);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return tokens.map((text, wi) => {
    const dur = (weights[wi] / total) * span;
    const w = { text, start: t, end: t + dur };
    t += dur;
    return w;
  });
}

export function parseSRT(srt) {
  const blocks = srt.trim().split(/\n\s*\n/);
  const lines = [];

  for (const block of blocks) {
    const rows = block.split(/\r?\n/).filter(Boolean);
    if (rows.length < 2) continue;
    const timeRow = rows.find((r) => r.includes('-->'));
    if (!timeRow) continue;
    const [a, b] = timeRow.split('-->').map(parseTimestamp);
    const text = rows.slice(rows.indexOf(timeRow) + 1).join(' ').trim();
    if (!text) continue;
    lines.push({
      start: a,
      end: b,
      words: interpolateWords(text, a, b),
    });
  }

  lines.sort((x, y) => x.start - y.start);
  const duration = lines.length ? lines[lines.length - 1].end : 0;
  return { lines, duration };
}
