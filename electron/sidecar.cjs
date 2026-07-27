// Durable alignment sidecars — the piece that makes an alignment an ASSET
// rather than a browser blob.
//
// Two locations, checked in this order on read:
//
//   1. Next to the audio file:  "Adele - Someone Like You.lyx.json"
//      Portable and shareable — copy the folder and the karaoke timing comes
//      with it. This is the Apple model: the timing ships with the recording.
//   2. userData/alignments/<sha256(key)>.json
//      For streaming tracks, where there is no local file to sit beside.
//
// localStorage stays the hot path in the renderer; these files are the backing
// store that survives a cache clear, a quota eviction, and a reinstall.
//
// Everything here treats the file content as UNTRUSTED (a sidecar may have been
// written by another machine): we bound the size, parse defensively, and leave
// structural validation to the renderer's `importEntry`.

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SIDECAR_EXT = '.lyx.json';
const SCHEMA = 1;
const MAX_BYTES = 4 * 1024 * 1024; // a long song is ~100 KB; 4 MB is absurdly generous
const MAX_STORE_FILES = 200;

// `electron` is required lazily so this module (and its file I/O) can be
// unit-tested in plain node; tests point the store at a temp dir instead.
let storeDirOverride = null;

function storeDir() {
  if (storeDirOverride) return storeDirOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'alignments');
}

/** @internal test seam — redirect the userData store to a temp directory. */
function setStoreDir(dir) {
  storeDirOverride = dir || null;
}

function storeFileFor(key) {
  const hash = createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
  return path.join(storeDir(), `${hash}.json`);
}

/** "…/Song.mp3" → "…/Song.lyx.json". Null unless we got a usable absolute path. */
function siblingFileFor(audioPath) {
  if (!audioPath || typeof audioPath !== 'string') return null;
  if (!path.isAbsolute(audioPath)) return null;
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath).replace(/\.[^.]+$/, '');
  if (!base) return null;
  return path.join(dir, base + SIDECAR_EXT);
}

async function readJson(file) {
  if (!file) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.timeline?.lines?.length) return null;
    return parsed;
  } catch {
    return null; // missing, unreadable, or malformed — indistinguishable and equally fine
  }
}

/** Write via temp + rename so a crash can't leave a half-written sidecar. */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Read the alignment for a track.
 * @param {{ key?: string, audioPath?: string }} payload
 * @returns {Promise<{ entry: object, from: 'sibling'|'store' }|null>}
 */
async function readAlignment({ key, audioPath } = {}) {
  const sibling = await readJson(siblingFileFor(audioPath));
  if (sibling) return { entry: sibling, from: 'sibling' };
  if (key) {
    const stored = await readJson(storeFileFor(key));
    if (stored) return { entry: stored, from: 'store' };
  }
  return null;
}

/**
 * Persist an alignment. Always writes the userData store; additionally writes
 * next to the audio file when we have one and the folder is writable (a
 * read-only volume or a sandboxed path is a soft failure, not an error).
 *
 * @param {{ key: string, audioPath?: string, alignVersion?: number, meta?: object, timeline: object }} payload
 * @returns {Promise<{ ok: boolean, store: boolean, sibling: boolean, error?: string }>}
 */
async function writeAlignment({ key, audioPath, alignVersion, meta, timeline } = {}) {
  if (!key || !timeline?.lines?.length) {
    return { ok: false, store: false, sibling: false, error: 'nothing to write' };
  }
  const payload = {
    schema: SCHEMA,
    key,
    alignVersion: alignVersion ?? null,
    savedAt: Date.now(),
    meta: meta || {},
    timeline,
  };

  let store = false;
  let sibling = false;
  let error;

  try {
    await writeJsonAtomic(storeFileFor(key), payload);
    store = true;
  } catch (err) {
    error = String(err?.message || err);
  }

  const siblingPath = siblingFileFor(audioPath);
  if (siblingPath) {
    try {
      await writeJsonAtomic(siblingPath, payload);
      sibling = true;
    } catch {
      // Read-only folder / permission denied — the store copy still has it.
    }
  }

  if (store) pruneStore().catch(() => {});
  return { ok: store || sibling, store, sibling, error };
}

/** Keep the newest MAX_STORE_FILES alignments; the sibling copies are untouched. */
async function pruneStore() {
  const dir = storeDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files = names.filter((n) => n.endsWith('.json'));
  if (files.length <= MAX_STORE_FILES) return;

  const stats = await Promise.all(
    files.map(async (name) => {
      try {
        const s = await fs.stat(path.join(dir, name));
        return { name, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  stats
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(MAX_STORE_FILES)
    .forEach(({ name }) => {
      fs.unlink(path.join(dir, name)).catch(() => {});
    });
}

module.exports = { readAlignment, writeAlignment, setStoreDir, SIDECAR_EXT };
