// Pure helpers for song-language identification (prompt build + reply parse).
//
// Whisper transcribes far better with an explicit language than with tiny-model
// auto-detection (Hindi songs otherwise come out as English mush). We ask the
// LLM for the language the song is SUNG in, from artist/track/album metadata.

// Whisper (Transformers.js) accepts full lowercase English language names.
const KNOWN_LANGUAGES = new Set([
  'english', 'hindi', 'punjabi', 'urdu', 'spanish', 'french', 'german', 'italian',
  'portuguese', 'korean', 'japanese', 'chinese', 'mandarin', 'cantonese', 'tamil',
  'telugu', 'malayalam', 'kannada', 'bengali', 'marathi', 'gujarati', 'arabic',
  'turkish', 'russian', 'ukrainian', 'polish', 'dutch', 'swedish', 'norwegian',
  'danish', 'finnish', 'greek', 'hebrew', 'thai', 'vietnamese', 'indonesian',
  'malay', 'filipino', 'tagalog', 'swahili', 'amharic', 'yoruba', 'persian',
  'nepali', 'sinhala', 'burmese', 'khmer', 'lao',
]);

export function buildLanguagePrompt({ artist, track, album }) {
  const parts = [
    track && `Track: ${track}`,
    artist && `Artist: ${artist}`,
    album && `Album: ${album}`,
  ].filter(Boolean);
  return [
    'What language is this song most likely SUNG in?',
    ...parts,
    '',
    'Reply with ONE lowercase English word for the language (e.g. "english", "hindi", "punjabi", "spanish").',
    'If it is likely multilingual, give the dominant language.',
    'If you truly cannot tell, reply "unknown".',
  ].join('\n');
}

/** Parse the reply to a Whisper-compatible language name, or null. */
export function parseLanguageReply(reply) {
  const word = String(reply || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)[0];
  if (!word || word === 'unknown') return null;
  if (word === 'mandarin' || word === 'cantonese') return 'chinese';
  if (word === 'tagalog') return 'filipino';
  return KNOWN_LANGUAGES.has(word) ? word : null;
}
