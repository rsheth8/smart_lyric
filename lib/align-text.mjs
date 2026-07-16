// Turn a line's words into a CTC transcript token sequence for forced alignment.
//
// wav2vec2-style CTC models use a character vocab with '|' as the word separator.
// We enclose the transcript with separators ("|WORD|WORD|") — exactly the shape
// `lib/forced-align.mjs` expects — and drop characters the model doesn't know
// (punctuation, out-of-script letters). Pure + dependency-free so it's testable
// without a model; the model runner passes in the real vocab.

/** Map a single character to a label id, trying case variants the vocab may use. */
export function charToId(vocab, ch) {
  if (vocab[ch] != null) return vocab[ch];
  const up = ch.toUpperCase();
  if (vocab[up] != null) return vocab[up];
  const lo = ch.toLowerCase();
  if (vocab[lo] != null) return vocab[lo];
  return null;
}

/**
 * Build the enclosed token sequence plus a map from each emitted word group back
 * to its original index in `words` (words whose characters are all out-of-vocab
 * are skipped and won't get a span).
 * @param {string[]} words
 * @param {Record<string, number>} vocab  char → label id
 * @param {{ separator?: string }} [opts]
 * @returns {{ tokens: number[], groupWordIndices: number[], separatorId: number|null }}
 */
export function buildTranscript(words, vocab, { separator = '|' } = {}) {
  const separatorId = charToId(vocab, separator);
  if (separatorId == null) return { tokens: [], groupWordIndices: [], separatorId: null };

  const tokens = [separatorId];
  const groupWordIndices = [];
  words.forEach((word, i) => {
    const ids = [];
    for (const ch of String(word)) {
      const id = charToId(vocab, ch);
      if (id != null && id !== separatorId) ids.push(id);
    }
    if (!ids.length) return; // nothing alignable in this word
    tokens.push(...ids, separatorId);
    groupWordIndices.push(i);
  });

  // Only a leading separator means nothing aligned.
  if (tokens.length <= 1) return { tokens: [], groupWordIndices: [], separatorId };
  return { tokens, groupWordIndices, separatorId };
}
