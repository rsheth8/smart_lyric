// Recently-played store — the thing that makes Bar4Bar feel owned rather than
// one-shot. Deliberately keyed with `cacheKey()` from timeline-cache.js so a
// library row can ask "is this one already vocal-aligned?" with a plain lookup
// against the timelines we've cached anyway, no second index to keep in sync.
//
// The pure functions (addEntry / rankRecent) take and return plain arrays so
// they're unit-testable without localStorage.

import { cacheKey } from './timeline-cache.js';

const STORAGE_KEY = 'bar4bar.library.v1';
const MAX_ENTRIES = 200;

/**
 * @typedef {{
 *   key: string, artist: string, track: string, art?: string|null,
 *   duration?: number|null, source?: string|null,
 *   lastPlayedAt: number, plays: number
 * }} LibraryEntry
 */

/**
 * Fold a play into a list of entries. Pure: returns a NEW array, most-recent
 * first, deduped by key (an existing entry is moved to the front and its play
 * count incremented rather than duplicated), capped at `max`.
 *
 * @param {LibraryEntry[]} entries
 * @param {object} meta - track meta ({ artist, track, duration, id/spotifyId, ... })
 * @param {{ now?: number, max?: number, art?: string|null, source?: string|null }} [opts]
 * @returns {LibraryEntry[]}
 */
export function addEntry(entries, meta, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const key = cacheKey(meta);
  if (!key) return list.slice(0, opts.max ?? MAX_ENTRIES);

  const { now = Date.now(), max = MAX_ENTRIES } = opts;
  const prev = list.find((e) => e.key === key);
  const entry = {
    key,
    artist: String(meta.artist || ''),
    track: String(meta.track || ''),
    // Keep whatever art/source we already had if this play didn't supply one —
    // a Spotify play knows the cover, a re-sync from a local file may not.
    art: opts.art ?? prev?.art ?? null,
    duration: Number.isFinite(meta.duration) ? Number(meta.duration) : prev?.duration ?? null,
    source: opts.source ?? prev?.source ?? null,
    lastPlayedAt: now,
    plays: (prev?.plays || 0) + 1,
  };

  return [entry, ...list.filter((e) => e.key !== key)].slice(0, max);
}

/**
 * Most-recent-first ordering. Stored data is already sorted, but a hand-edited
 * or merged store shouldn't render out of order.
 * @param {LibraryEntry[]} entries
 * @returns {LibraryEntry[]}
 */
export function rankRecent(entries) {
  return [...(entries || [])].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

/**
 * Human "when" label for a library row.
 * @param {number} ts - epoch ms
 * @param {number} [now]
 */
export function relativeWhen(ts, now = Date.now()) {
  const sec = Math.max(0, (now - ts) / 1000);
  if (sec < 90) return 'just now';
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)} min ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  const day = hr / 24;
  if (day < 2) return 'yesterday';
  if (day < 7) return `${Math.round(day)} days ago`;
  const wk = day / 7;
  if (wk < 5) return `${Math.round(wk)} wk ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// --- persistence -------------------------------------------------------------

/** @returns {LibraryEntry[]} */
export function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? rankRecent(parsed) : [];
  } catch {
    return [];
  }
}

export function saveLibrary(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    return true;
  } catch {
    // Quota — the align cache is the bigger tenant and it self-trims; losing a
    // library write is never worth breaking playback over.
    return false;
  }
}

/** Record a play. Returns the updated list. */
export function recordPlay(meta, opts = {}) {
  const next = addEntry(loadLibrary(), meta, opts);
  saveLibrary(next);
  return next;
}

/**
 * Attach artwork to an already-recorded play WITHOUT counting a new one.
 * Artwork resolves asynchronously after playback starts, so the row is written
 * first and illustrated a moment later.
 */
export function updateArt(meta, art) {
  const key = cacheKey(meta);
  if (!key || !art) return false;
  const list = loadLibrary();
  const entry = list.find((e) => e.key === key);
  if (!entry || entry.art === art) return false;
  entry.art = art;
  saveLibrary(list);
  return true;
}

export function clearLibrary() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export { MAX_ENTRIES };
