// Persist vocal-aligned timelines so the second play of a song is instant.
// Keys prefer a stable provider id (Spotify track id); otherwise artist|track|duration.
// localStorage is fine for compact word spans (DOM refs are stripped on write).

const STORAGE_KEY = 'bar4bar.alignCache.v2';
const ALIGN_VERSION = 2; // bump when aligner semantics change (v2: full-song only)
const MAX_ENTRIES = 80;

/** @typedef {{ artist?: string, track?: string, album?: string, duration?: number, id?: string, spotifyId?: string, source?: string, format?: string }} TrackMeta */

/**
 * Stable cache key for a track. Prefers Spotify/provider ids.
 * @param {TrackMeta} meta
 * @returns {string|null}
 */
export function cacheKey(meta) {
  if (!meta) return null;
  const id = meta.spotifyId || meta.id;
  if (id) return `id:${id}`;
  const track = norm(meta.track);
  if (!track) return null;
  const artist = norm(meta.artist);
  const dur = meta.duration != null && Number.isFinite(meta.duration)
    ? Math.round(Number(meta.duration))
    : '';
  return `t:${artist}|${track}|${dur}`;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { v: ALIGN_VERSION, entries: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { v: ALIGN_VERSION, entries: {} };
    if (parsed.v !== ALIGN_VERSION) return { v: ALIGN_VERSION, entries: {} };
    return { v: ALIGN_VERSION, entries: parsed.entries || {} };
  } catch {
    return { v: ALIGN_VERSION, entries: {} };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota / private mode — ignore; alignment still works without cache.
  }
}

/** Compact a live timeline into JSON-safe word spans (no DOM refs). */
export function serializeTimeline(timeline) {
  if (!timeline?.lines?.length) return null;
  return {
    duration: timeline.duration,
    estimated: !!timeline.estimated,
    aligned: !!timeline.aligned,
    hasRoman: !!timeline.hasRoman,
    lines: timeline.lines.map((line) => ({
      start: line.start,
      end: line.end,
      roman: line.roman || undefined,
      english: line.english || undefined,
      words: (line.words || []).map((w) => ({
        text: w.text,
        start: w.start,
        end: w.end,
      })),
    })),
  };
}

/**
 * Apply cached word timings onto a freshly parsed timeline (same line/word counts).
 * Mutates `timeline` in place. Returns true when applied.
 */
export function applyCachedTiming(timeline, cached) {
  if (!timeline?.lines?.length || !cached?.lines?.length) return false;
  if (timeline.lines.length !== cached.lines.length) return false;

  for (let i = 0; i < timeline.lines.length; i++) {
    const line = timeline.lines[i];
    const src = cached.lines[i];
    if (!src?.words?.length || !line.words?.length) return false;
    if (line.words.length !== src.words.length) return false;
    // Line anchors should be close (same recording); allow small provider drift.
    if (Math.abs((line.start || 0) - (src.start || 0)) > 2.5) return false;

    for (let j = 0; j < line.words.length; j++) {
      const w = line.words[j];
      const sw = src.words[j];
      if (!sw || norm(w.text) !== norm(sw.text)) return false;
      w.start = sw.start;
      w.end = sw.end;
    }
    line._vocalAligned = true;
  }
  timeline.aligned = true;
  return true;
}

/** @returns {{ timeline: object, meta?: object, savedAt: number }|null} */
export function getCachedTimeline(key) {
  if (!key || typeof localStorage === 'undefined') return null;
  const store = loadStore();
  const entry = store.entries[key];
  if (!entry?.timeline?.lines?.length) return null;
  return entry;
}

/** Save an aligned timeline under `key`. */
export function putCachedTimeline(key, timeline, meta = {}) {
  if (!key || !timeline?.aligned || typeof localStorage === 'undefined') return false;
  const serialized = serializeTimeline(timeline);
  if (!serialized) return false;

  const store = loadStore();
  store.entries[key] = {
    savedAt: Date.now(),
    meta: {
      artist: meta.artist,
      track: meta.track,
      duration: meta.duration,
      format: meta.format,
      source: meta.source,
    },
    timeline: serialized,
  };

  // Evict oldest when over cap.
  const keys = Object.keys(store.entries);
  if (keys.length > MAX_ENTRIES) {
    keys
      .map((k) => ({ k, t: store.entries[k].savedAt || 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(({ k }) => {
        delete store.entries[k];
      });
  }

  saveStore(store);
  return true;
}

export { ALIGN_VERSION };
