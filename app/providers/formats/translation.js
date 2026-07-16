// Line-level translation lyrics (NetEase `tlyric`) → attached onto a timeline.
//
// The translation is plain LRC: `[mm:ss.xx]translated text`, one entry per sung
// line, sharing the original's timestamps. We parse those stamps and hang each
// translation onto the nearest timeline line by start time, so a word-level yrc
// timeline (whose line starts differ slightly from the lrc) still lines up.

const TS = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parse translation LRC into sorted `{ start, text }` entries. */
export function parseTranslationLrc(lrc) {
  const out = [];
  for (const raw of (lrc || '').split(/\r?\n/)) {
    TS.lastIndex = 0;
    const stamps = [];
    let m;
    let lastEnd = 0;
    while ((m = TS.exec(raw)) !== null) {
      const fr = m[3] ? parseFloat(`0.${m[3]}`) : 0;
      stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fr);
      lastEnd = TS.lastIndex;
    }
    if (!stamps.length) continue;
    const text = raw.slice(lastEnd).trim();
    if (!text) continue; // blank / metadata-only line
    for (const start of stamps) out.push({ start, text });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Attach a timestamped LRC overlay (translation or romanization) onto
 * `timeline.lines[].{field}` in place, matching by nearest start within
 * `tolerance`. Sets `timeline.has{Field}` (e.g. `hasRoman`). Returns the count.
 */
export function attachLineText(timeline, lrc, field, { tolerance = 3 } = {}) {
  const entries = parseTranslationLrc(lrc);
  if (!entries.length || !timeline?.lines?.length) return 0;

  let matched = 0;
  for (const line of timeline.lines) {
    let best = null;
    let bestDiff = Infinity;
    for (const e of entries) {
      const d = Math.abs(e.start - line.start);
      if (d < bestDiff) {
        bestDiff = d;
        best = e;
      }
    }
    if (best && bestDiff <= tolerance) {
      // Skip an overlay that's just a copy of the original (no-op line).
      const original = line.words?.map((w) => w.text).join(' ').trim();
      if (best.text && best.text !== original) {
        line[field] = best.text;
        matched++;
      }
    }
  }
  const flag = `has${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  timeline[flag] = matched > 0;
  return matched;
}

/** Back-compat: attach NetEase translation onto `line.translation`. */
export function attachTranslation(timeline, translationLrc, opts) {
  attachLineText(timeline, translationLrc, 'translation', opts);
  return timeline;
}
