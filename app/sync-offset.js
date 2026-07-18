// Per-song + device timing offsets.
//
// Early/late feel is almost never BPM — digital Spotify runs at rate 1.0. It's a
// fixed lag between the reported playhead and what reaches the speakers (device
// buffer, Bluetooth, soundbar). That lag is mostly stable per *playback path*,
// with a smaller per-song component when a lyric catalog is slightly early/late.
//
// Strategy:
//   1. Remember the offset the user dialed for each track (Spotify id preferred).
//   2. Keep a device default = EMA of recent nudges — used for songs we haven't
//      tuned yet, so the next track is close "off the jump."
// BPM / tempo APIs can't measure speaker latency; only listening (or a prior
// nudge) can.

const STORE_KEY = 'bar4bar.syncOffsets.v1';
const MAX_TRACKS = 200;
const EMA_ALPHA = 0.35; // how fast the device default follows new nudges
// After a couple of songs on this playback path, trust / train the device
// default more aggressively (BT vs speakers often differ by 100–300ms).
const PATH_TRUST_AFTER = 2;

/** @typedef {{ artist?: string, track?: string, duration?: number, id?: string, spotifyId?: string }} TrackMeta */

export function trackKey(meta) {
  if (!meta) return null;
  const id = meta.spotifyId || meta.id;
  if (id) return `id:${id}`;
  const track = norm(meta.track);
  if (!track) return null;
  const artist = norm(meta.artist);
  const dur =
    meta.duration != null && Number.isFinite(meta.duration) ? Math.round(Number(meta.duration)) : '';
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

function clamp(sec) {
  const n = Math.round(Number(sec) * 1000) / 1000;
  if (!Number.isFinite(n)) return 0;
  return Math.max(-2, Math.min(2, n));
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { deviceDefault: 0, tracks: {}, pathSamples: 0 };
    const parsed = JSON.parse(raw);
    return {
      deviceDefault: clamp(parsed.deviceDefault || 0),
      tracks: parsed.tracks && typeof parsed.tracks === 'object' ? parsed.tracks : {},
      pathSamples: Math.max(0, parseInt(parsed.pathSamples, 10) || 0),
    };
  } catch {
    return { deviceDefault: 0, tracks: {}, pathSamples: 0 };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* quota / private mode */
  }
}

/** Migrate the legacy single global offset into the device default once. */
export function migrateLegacyOffset(legacySec) {
  if (!Number.isFinite(legacySec) || legacySec === 0) return;
  const store = loadStore();
  if (store.deviceDefault !== 0 || Object.keys(store.tracks).length) return;
  store.deviceDefault = clamp(legacySec);
  saveStore(store);
}

export function getDeviceDefault() {
  return loadStore().deviceDefault;
}

/** How many songs have trained the device-default latency for this path. */
export function getPathSamples() {
  return loadStore().pathSamples || 0;
}

/**
 * Prior weight for SyncEstimator.seed — stronger once this output path has
 * been measured on a couple of songs.
 */
export function devicePriorWeight() {
  const n = getPathSamples();
  if (n >= PATH_TRUST_AFTER) return 1.45;
  if (n >= 1) return 1.0;
  return 0.75;
}

function emaAlpha(pathSamples) {
  return pathSamples >= PATH_TRUST_AFTER ? 0.5 : EMA_ALPHA;
}

/**
 * Best offset to use when a song starts.
 * @returns {{ offset: number, source: 'track'|'device'|'zero', pathSamples: number }}
 */
export function resolveOffset(meta) {
  const store = loadStore();
  const key = trackKey(meta);
  if (key && store.tracks[key] && Number.isFinite(store.tracks[key].offset)) {
    return {
      offset: clamp(store.tracks[key].offset),
      source: 'track',
      key,
      pathSamples: store.pathSamples,
    };
  }
  if (store.deviceDefault) {
    return {
      offset: store.deviceDefault,
      source: 'device',
      key,
      pathSamples: store.pathSamples,
    };
  }
  return { offset: 0, source: 'zero', key, pathSamples: store.pathSamples };
}

/**
 * Persist a user nudge / auto-lock for the current track and fold it into the
 * device default. `fromLock` counts toward path trust (mic-learned latency).
 */
export function rememberOffset(meta, offsetSec, { fromLock = false } = {}) {
  const offset = clamp(offsetSec);
  const store = loadStore();
  const key = trackKey(meta);
  const alpha = emaAlpha(store.pathSamples || 0);

  // Device default tracks the user's typical latency (speakers / BT / Spotify).
  store.deviceDefault = clamp(store.deviceDefault * (1 - alpha) + offset * alpha);

  // Count path trust once per track that mic-locks (not every converging nudge).
  if (fromLock) {
    const alreadyLocked = key && store.tracks[key]?.locked;
    if (!alreadyLocked) store.pathSamples = (store.pathSamples || 0) + 1;
  } else if (key) {
    // First manual tune still marks the path as seen so the next song seeds
    // with a slightly stronger prior.
    store.pathSamples = Math.max(store.pathSamples || 0, 1);
  }

  if (key) {
    const prev = store.tracks[key];
    store.tracks[key] = {
      offset,
      savedAt: Date.now(),
      locked: Boolean(fromLock || prev?.locked),
    };
    const keys = Object.keys(store.tracks);
    if (keys.length > MAX_TRACKS) {
      keys
        .map((k) => ({ k, t: store.tracks[k].savedAt || 0 }))
        .sort((a, b) => a.t - b.t)
        .slice(0, keys.length - MAX_TRACKS)
        .forEach(({ k }) => {
          delete store.tracks[k];
        });
    }
  }

  saveStore(store);
  return { offset, key, deviceDefault: store.deviceDefault, pathSamples: store.pathSamples };
}

/** Clear the per-track override (falls back to device default next resolve). */
export function clearTrackOffset(meta) {
  const key = trackKey(meta);
  if (!key) return;
  const store = loadStore();
  delete store.tracks[key];
  saveStore(store);
}

/** Reset everything to zero. */
export function resetAllOffsets() {
  saveStore({ deviceDefault: 0, tracks: {}, pathSamples: 0 });
}
