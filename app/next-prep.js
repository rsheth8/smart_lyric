// Background prep for the *next* Spotify track while the current one plays.
// Catalog lyrics + cache hydrate only — never AI (that needs live audio of the
// wrong song). On track change, the live session installs this buffer instantly
// so the first lines aren't blank while a fresh NetEase/LRCLIB round-trip runs.

import { fetchCatalogLyrics } from './providers/lyrics/index.js';
import { cacheKey, getCachedTimeline } from './timeline-cache.js';
import { hydrateFromSidecar } from './sidecar.js';
import { resolveOffset } from './sync-offset.js';

/** @typedef {{ id?: string, artist?: string, title?: string, track?: string, name?: string, album?: string, duration?: number, uri?: string, spotifyId?: string }} PrepMeta */

let gen = 0;
/** @type {{ gen: number, meta: PrepMeta, result: object|null, offset: object|null, promise: Promise<any>|null, status: string }|null} */
let prep = null;

export function clearNextPrep() {
  gen += 1;
  prep = null;
}

export function peekNextPrep() {
  return prep;
}

export function trackIdentity(meta) {
  if (!meta) return '';
  if (meta.id || meta.spotifyId) return `id:${meta.id || meta.spotifyId}`;
  const title = meta.title || meta.track || meta.name || '';
  return `${meta.artist || ''}::${title}`;
}

export function sameTrack(a, b) {
  if (!a || !b) return false;
  const idA = a.id || a.spotifyId;
  const idB = b.id || b.spotifyId;
  if (idA && idB) return idA === idB;
  return trackIdentity(a) === trackIdentity(b);
}

/**
 * Start (or keep) a catalog fetch for `meta`. No-ops if already prepping / ready
 * for the same track. Safe to call from the poll loop.
 *
 * Optional injectors (`fetchCatalog`, `hydrate`, `resolve`) exist for tests.
 */
export function ensureNextPrep(meta, {
  skipIf,
  fetchCatalog = fetchCatalogLyrics,
  hydrate = hydrateFromSidecar,
  resolve = resolveOffset,
  peekCache = getCachedTimeline,
} = {}) {
  if (!meta) return null;
  const title = meta.title || meta.track || meta.name;
  if (!title) return null;
  if (skipIf && sameTrack(meta, skipIf)) return null;

  if (prep && sameTrack(prep.meta, meta)) {
    return prep.promise || Promise.resolve(prep);
  }

  const myGen = ++gen;
  const entry = {
    gen: myGen,
    meta: {
      id: meta.id,
      spotifyId: meta.id || meta.spotifyId,
      artist: meta.artist,
      title,
      track: title,
      album: meta.album,
      duration: meta.duration,
      uri: meta.uri,
    },
    result: null,
    offset: null,
    promise: null,
    status: 'loading',
  };
  prep = entry;

  entry.promise = (async () => {
    const query = {
      artist: entry.meta.artist,
      track: entry.meta.track,
      album: entry.meta.album,
      duration: entry.meta.duration,
    };
    // Warm localStorage from any on-disk sidecar before the catalog returns,
    // so applyResult can hit the align cache the moment we commit.
    try {
      await hydrate({ key: cacheKey(entry.meta), audioFile: null });
    } catch {
      /* sidecar is best-effort */
    }

    let result = null;
    try {
      result = await fetchCatalog(query);
    } catch {
      result = null;
    }
    if (myGen !== gen || prep !== entry) return null;

    entry.result = result;
    entry.offset = resolve(entry.meta);
    entry.status = result ? 'ready' : 'miss';
    if (result) peekCache(cacheKey(entry.meta));
    return entry;
  })();

  return entry.promise;
}

/**
 * Claim a finished (or nearly finished) prep for the track that just started.
 * Waits up to `waitMs` if the fetch is still in flight — better than starting
 * a duplicate catalog round-trip from scratch.
 * @returns {Promise<{ meta: PrepMeta, result: object|null, offset: object|null, status: string }|null>}
 */
export async function takeReadyPrep(meta, { waitMs = 2500 } = {}) {
  if (!prep || !sameTrack(prep.meta, meta)) return null;
  const entry = prep;
  prep = null; // ownership transfers; a later ensureNextPrep can start the *new* next
  if (entry.status === 'ready' || entry.status === 'miss') return entry;
  if (!entry.promise) return entry;

  try {
    await Promise.race([
      entry.promise,
      new Promise((r) => setTimeout(r, waitMs)),
    ]);
  } catch {
    /* treat as miss */
  }
  return entry;
}
