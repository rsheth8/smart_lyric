// Renderer half of durable alignment sidecars.
//
// localStorage stays the hot path — every read in `SongSession.applyResult` is
// still synchronous. This module is the BACKING store around it: pull a sidecar
// into localStorage before a load, push one back out after an alignment
// completes. That's what makes an alignment survive a cache clear, a quota
// eviction, or a reinstall, and what makes it travel with the audio file.
//
// Soft-fails to a no-op everywhere the bridge is missing (web build, browser
// preview), exactly like `app/align.js`.

import { importEntry, exportEntry, ALIGN_VERSION } from './timeline-cache.js';

/** True when the Electron bridge can persist sidecars. */
export function sidecarAvailable() {
  return typeof window !== 'undefined' && typeof window.bar4bar?.readAlignment === 'function';
}

/**
 * Electron 31 still exposes the real path on a picked File. Absent in the web
 * build (and on a File synthesized from a drop of remote data), in which case
 * we simply fall back to the userData store.
 */
function audioPathOf(file) {
  const p = file?.path;
  return typeof p === 'string' && p ? p : undefined;
}

/**
 * Pull the on-disk alignment for this track into localStorage, if there is one
 * and it beats what we already have.
 *
 * @param {{ key: string|null, audioFile?: File }} query
 * @returns {Promise<{ imported: boolean, from?: 'sibling'|'store' }>}
 */
export async function hydrateFromSidecar({ key, audioFile } = {}) {
  if (!sidecarAvailable()) return { imported: false };
  const audioPath = audioPathOf(audioFile);
  if (!key && !audioPath) return { imported: false };

  try {
    const found = await window.bar4bar.readAlignment({ key: key || undefined, audioPath });
    if (!found?.entry) return { imported: false };
    // A sibling sidecar is keyed by the FILE, so trust the key we're loading
    // under rather than the one recorded inside it.
    const imported = importEntry(key || found.entry.key, found.entry);
    return { imported, from: found.from };
  } catch {
    return { imported: false };
  }
}

/**
 * Push the stored alignment for `key` out to disk. Fire-and-forget: the
 * localStorage write has already happened, so a failure here costs durability,
 * never correctness.
 *
 * @param {{ key: string|null, audioFile?: File }} query
 * @returns {Promise<{ ok: boolean, store?: boolean, sibling?: boolean }>}
 */
export async function saveToSidecar({ key, audioFile } = {}) {
  if (!sidecarAvailable() || !key) return { ok: false };
  const entry = exportEntry(key);
  if (!entry?.timeline?.lines?.length) return { ok: false };

  try {
    return await window.bar4bar.writeAlignment({
      key,
      audioPath: audioPathOf(audioFile),
      alignVersion: entry.alignVersion ?? ALIGN_VERSION,
      meta: entry.meta,
      timeline: entry.timeline,
    });
  } catch {
    return { ok: false };
  }
}
