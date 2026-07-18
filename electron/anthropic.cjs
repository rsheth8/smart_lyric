// Anthropic (Claude) client for lyric cleanup — Electron main process only,
// so the API key never reaches the renderer.
//
// Usage policy: one call per song (all lines batched). The limiter below is a
// safety net against runaway loops, not a stinginess knob — quality wins.

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 30000;

// Safety-net rate limit: at most N calls per rolling minute + small spacing.
const MAX_CALLS_PER_MINUTE = 10;
const MIN_INTERVAL_MS = 1500;

let _callTimes = [];
let _lastCall = 0;

function anthropicConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function rateLimitCheck() {
  const now = Date.now();
  _callTimes = _callTimes.filter((t) => now - t < 60_000);
  if (_callTimes.length >= MAX_CALLS_PER_MINUTE) {
    return 'Rate limit: too many Claude calls this minute — try again shortly.';
  }
  if (now - _lastCall < MIN_INTERVAL_MS) {
    return 'Rate limit: Claude calls too close together.';
  }
  return null;
}

/**
 * One messages-API call. Retries once on 429/5xx with backoff.
 * @returns {Promise<{ text: string }|{ error: string }>}
 */
async function anthropicComplete({ prompt, maxTokens = 3000, system }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'ANTHROPIC_API_KEY not set in .env' };

  const limited = rateLimitCheck();
  if (limited) return { error: limited };
  _callTimes.push(Date.now());
  _lastCall = Date.now();

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (system) body.system = system;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          const retryAfter = Number(res.headers.get('retry-after')) || 3;
          await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
          continue;
        }
        return { error: `Claude API ${res.status}` };
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { error: `Claude API ${res.status}: ${detail.slice(0, 200)}` };
      }
      const data = await res.json();
      const text = (data?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return { text, model: data?.model || ANTHROPIC_MODEL };
    } catch (e) {
      if (attempt === 0) continue;
      return { error: e.message || String(e) };
    }
  }
  return { error: 'Claude API failed after retry' };
}

/**
 * Clean ASR lyric lines. Input/output are plain string arrays; prompt building
 * and reply parsing live in lib/lyric-cleanup.mjs (unit-tested).
 * @param {{ lines: string[], artist?: string, track?: string }} payload
 */
async function cleanLyricLines(payload = {}) {
  const lines = Array.isArray(payload.lines) ? payload.lines.map((l) => String(l || '')) : [];
  if (!lines.length) return { error: 'No lines to clean.' };
  if (!anthropicConfigured()) return { error: 'ANTHROPIC_API_KEY not set in .env' };

  const { buildCleanupPrompt, parseCleanupReply, cleanedLinesLookSane } = await import(
    '../lib/lyric-cleanup.mjs'
  );

  const prompt = buildCleanupPrompt({ lines, artist: payload.artist, track: payload.track });
  console.log(`[claude] cleaning ${lines.length} lyric lines…`);
  const res = await anthropicComplete({
    prompt,
    system:
      'You are a careful lyrics editor. You fix ASR transcription errors without inventing content.',
    maxTokens: Math.min(8000, 200 + lines.join(' ').length * 2),
  });
  if (res.error) {
    console.warn('[claude] cleanup failed:', res.error);
    return { error: res.error };
  }

  const cleaned = parseCleanupReply(res.text, lines.length);
  if (!cleaned) {
    console.warn('[claude] reply had wrong line count — keeping original transcript');
    return { error: 'Cleanup reply unusable (line count mismatch).' };
  }
  if (!cleanedLinesLookSane(lines, cleaned)) {
    console.warn('[claude] cleanup rewrote too much — keeping original transcript');
    return { error: 'Cleanup rewrote too much — rejected.' };
  }
  console.log('[claude] cleanup applied');
  return { lines: cleaned, model: res.model };
}

// Cache language guesses per song — metadata never changes mid-session.
const _langCache = new Map();

/**
 * Guess the language a song is sung in from its metadata (one tiny Claude call,
 * cached). Returns a Whisper-compatible lowercase name like "hindi", or null.
 * @param {{ artist?: string, track?: string, album?: string }} payload
 */
async function guessSongLanguage(payload = {}) {
  if (!payload.track && !payload.artist) return { language: null };
  if (!anthropicConfigured()) return { language: null };

  const key = `${payload.artist || ''}|${payload.track || ''}|${payload.album || ''}`.toLowerCase();
  if (_langCache.has(key)) return { language: _langCache.get(key) };

  const { buildLanguagePrompt, parseLanguageReply } = await import('../lib/song-language.mjs');
  const res = await anthropicComplete({
    prompt: buildLanguagePrompt(payload),
    system: 'You identify song languages from metadata. Answer with a single word.',
    maxTokens: 10,
  });
  if (res.error) {
    console.warn('[claude] language guess failed:', res.error);
    return { language: null };
  }
  const language = parseLanguageReply(res.text);
  console.log(`[claude] language guess for "${payload.track}": ${language || 'unknown'}`);
  _langCache.set(key, language);
  return { language };
}

module.exports = { cleanLyricLines, guessSongLanguage, anthropicConfigured };
