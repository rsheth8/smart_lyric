// Pure helpers for LLM lyric cleanup (prompt build + response parse).
//
// The LLM receives the raw ASR lines NUMBERED and must return the same count,
// same order, same language — only fixing mishearings, casing, punctuation and
// obvious word-boundary errors. Keeping the mapping 1:1 is what lets us keep
// every line's start/end timing from the ASR timeline.

/** Build the one-shot cleanup prompt for a whole song. */
export function buildCleanupPrompt({ lines, artist, track }) {
  const numbered = lines.map((text, i) => `${i + 1}. ${text}`).join('\n');
  const who = [track && `"${track}"`, artist && `by ${artist}`].filter(Boolean).join(' ');
  return [
    `These are automatic speech-recognition captions of the song ${who || '(unknown)'} — likely with mishearings.`,
    'Clean them into readable lyric lines.',
    '',
    'Rules:',
    `- Return EXACTLY ${lines.length} lines, numbered the same way ("1. ", "2. ", …), same order.`,
    '- Fix obvious mishearings, homophones, word boundaries, casing and punctuation.',
    '- Keep the original language. Do NOT translate.',
    '- Do NOT invent verses, add words that change meaning, or merge/split lines.',
    '- If a line is already fine or you are unsure, return it unchanged.',
    '- Output ONLY the numbered lines, nothing else.',
    '',
    numbered,
  ].join('\n');
}

/**
 * Parse the LLM reply back into exactly `expectedCount` lines.
 * Returns null when the reply cannot be trusted (wrong count / empty).
 */
export function parseCleanupReply(reply, expectedCount) {
  if (!reply || !expectedCount) return null;
  const out = new Array(expectedCount).fill(null);
  const lines = String(reply).replace(/\r\n/g, '\n').split('\n');

  let unnumbered = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)[.)]\s*(.*)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < expectedCount && out[idx] == null) out[idx] = m[2].trim();
    } else {
      unnumbered.push(line);
    }
  }

  // Fallback: a reply with no numbering but the right line count is still usable.
  if (out.every((l) => l == null) && unnumbered.length === expectedCount) {
    return unnumbered;
  }
  if (out.some((l) => l == null || l === '')) return null;
  return out;
}

/**
 * Sanity-check cleaned lines against originals: reject wholesale rewrites.
 * A cleanup should share most of its words with the source line.
 */
export function cleanedLinesLookSane(original, cleaned, { minKeep = 0.35 } = {}) {
  if (!Array.isArray(original) || !Array.isArray(cleaned)) return false;
  if (original.length !== cleaned.length) return false;
  let okCount = 0;
  for (let i = 0; i < original.length; i++) {
    const a = tokenSet(original[i]);
    const b = tokenSet(cleaned[i]);
    if (!a.size || !b.size) {
      okCount++; // empty/short lines can't be scored — trust them
      continue;
    }
    let shared = 0;
    for (const t of b) if (a.has(t)) shared++;
    if (shared / b.size >= minKeep) okCount++;
  }
  return okCount / original.length >= 0.7;
}

function tokenSet(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .split(/\s+/)
      .filter(Boolean)
  );
}
