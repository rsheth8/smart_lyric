// Prepared word timings: audio stays on the preparation machine, never on Vercel.
import { createHash } from 'node:crypto';
import { hasIdentifier, validateRecording, recordingMatches, recordingStorageKey } from './recording-identity.mjs';

const normalized = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const timingKey = (artist, track) => createHash('sha256')
  .update(`${normalized(artist)}|${normalized(track)}`).digest('hex');
const storageKey = meta => hasIdentifier(meta.recording)
  ? createHash('sha256').update(recordingStorageKey(meta.recording)).digest('hex')
  : timingKey(meta.artist, meta.track);

export function validateTimings(value) {
  if (value?.version !== 1 || !value.meta?.artist || !value.meta?.track
    || !Number.isFinite(value.meta.duration) || value.meta.duration <= 0) throw new Error('Missing recording metadata.');
  const tl = value.timeline;
  if (value.meta.recording != null) validateRecording(value.meta.recording);
  if (tl?.source !== 'aligned' || typeof tl.estimated !== 'boolean'
    || !Array.isArray(tl.lines) || !tl.lines.length || tl.lines.length > 1000) throw new Error('Invalid prepared timeline.');
  let previous = -1, words = 0;
  for (const line of tl.lines) {
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < previous
      || line.start < 0 || line.end < line.start || line.end > value.meta.duration + 3
      || typeof line.uncertain !== 'boolean' || !Array.isArray(line.words) || !line.words.length) throw new Error('Invalid line bounds.');
    previous = line.start;
    let wordStart = line.start;
    for (const word of line.words) {
      if (typeof word.text !== 'string' || !word.text.trim() || word.text.length > 250
        || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < wordStart || word.end < word.start || word.end > line.end + 0.001
        || !Number.isFinite(word.score) || word.score < 0 || word.score > 1) throw new Error('Invalid word timing.');
      wordStart = word.start;
      if (++words > 10000) throw new Error('Timeline too large.');
    }
  }
  if (!value.quality || !Number.isFinite(value.quality.anchoredFraction)
    || value.quality.anchoredFraction < 0 || value.quality.anchoredFraction > 1) throw new Error('Missing alignment quality.');
  if (!tl.estimated && (value.quality.anchoredFraction !== 1 || tl.lines.some(line => line.uncertain))) {
    throw new Error('Uncertain words cannot be labeled fully timed.');
  }
  return value;
}

function storage(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Word timing storage is not configured.');
  return {
    url: `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/word_timings`,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
  };
}

export async function readTimings({ artist, track, duration, recording }, { env = process.env, fetcher = fetch } = {}) {
  if (!artist || !track || !Number.isFinite(duration) || duration <= 0) return null;
  const { url, headers } = storage(env);
  const query = new URLSearchParams({ select: 'value', track_key: `eq.${storageKey({ artist, track, recording })}`, limit: '8' });
  query.append('duration', `gte.${duration - 2.5}`);
  query.append('duration', `lte.${duration + 2.5}`);
  const response = await fetcher(`${url}?${query}`, { headers, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Word timing storage unavailable (${response.status}).`);
  const rows = await response.json();
  return rows.map(row => { try { return validateTimings(row.value); } catch { return null; } })
    .filter(value => value && timingKey(value.meta.artist, value.meta.track) === timingKey(artist, track)
      && (!hasIdentifier(recording) || recordingMatches(recording, value.meta.recording))
      && Math.abs(value.meta.duration - duration) <= 2.5)
    .sort((a, b) => Math.abs(a.meta.duration - duration) - Math.abs(b.meta.duration - duration))[0] ?? null;
}

export async function writeTimings(value, { env = process.env, fetcher = fetch } = {}) {
  validateTimings(value);
  const { url, headers } = storage(env);
  const key = storageKey(value.meta);
  // Store aliases only for identities explicitly attached to this reviewed audio.
  const keys = new Set([key]);
  const recording = value.meta.recording;
  if (recording?.appleMusicID) keys.add(storageKey({ recording: { appleMusicID: recording.appleMusicID } }));
  if (recording?.isrc && recording.explicit != null) keys.add(storageKey({ recording: { isrc: recording.isrc, explicit: recording.explicit } }));
  const rows = [...keys].map(key => ({ id: `${key}-${Math.round(value.meta.duration * 1000)}`,
    track_key: key, duration: value.meta.duration, value }));
  const response = await fetcher(url, {
    method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows.length === 1 ? rows[0] : rows),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Could not save word timings (${response.status}).`);
}
