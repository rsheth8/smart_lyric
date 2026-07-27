// Real-filesystem tests for the main-process sidecar writer. `electron` is
// required lazily inside sidecar.cjs, so this runs in plain node with the
// userData store pointed at a temp directory.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readAlignment, writeAlignment, setStoreDir, SIDECAR_EXT } = require('../electron/sidecar.cjs');

let tmp;
let store;
let music;

const TIMELINE = {
  duration: 14,
  aligned: true,
  lines: [{ start: 10, end: 14, words: [{ text: 'one', start: 10, end: 14 }] }],
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-'));
  store = path.join(tmp, 'store');
  music = path.join(tmp, 'music');
  await fs.mkdir(music, { recursive: true });
  setStoreDir(store);
});

afterEach(async () => {
  setStoreDir(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('writeAlignment', () => {
  test('writes both the sibling file and the userData store', async () => {
    const audioPath = path.join(music, 'Adele - Someone Like You.mp3');
    const res = await writeAlignment({ key: 'id:abc', audioPath, alignVersion: 2, timeline: TIMELINE });

    assert.deepEqual({ ok: res.ok, store: res.store, sibling: res.sibling }, {
      ok: true, store: true, sibling: true,
    });

    const sibling = path.join(music, `Adele - Someone Like You${SIDECAR_EXT}`);
    const parsed = JSON.parse(await fs.readFile(sibling, 'utf8'));
    assert.equal(parsed.key, 'id:abc');
    assert.equal(parsed.alignVersion, 2);
    assert.equal(parsed.timeline.lines[0].words[0].text, 'one');

    assert.equal((await fs.readdir(store)).length, 1);
  });

  test('leaves no temp files behind', async () => {
    await writeAlignment({
      key: 'id:abc',
      audioPath: path.join(music, 'Song.mp3'),
      timeline: TIMELINE,
    });
    const leftovers = (await fs.readdir(music)).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('stores only, when there is no local audio file (streaming)', async () => {
    const res = await writeAlignment({ key: 'id:spotify', timeline: TIMELINE });
    assert.equal(res.store, true);
    assert.equal(res.sibling, false);
  });

  test('ignores a relative or empty audio path', async () => {
    const res = await writeAlignment({ key: 'id:abc', audioPath: 'relative.mp3', timeline: TIMELINE });
    assert.equal(res.sibling, false);
    assert.equal(res.store, true);
  });

  test('a read-only folder degrades to a store-only write', async () => {
    const locked = path.join(tmp, 'locked');
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o500); // r-x: can't create the sidecar
    try {
      const res = await writeAlignment({
        key: 'id:abc',
        audioPath: path.join(locked, 'Song.mp3'),
        timeline: TIMELINE,
      });
      assert.equal(res.ok, true, 'still succeeded via the store');
      assert.equal(res.sibling, false);
      assert.equal(res.store, true);
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });

  test('refuses an empty payload', async () => {
    assert.equal((await writeAlignment({ key: 'id:abc' })).ok, false);
    assert.equal((await writeAlignment({ timeline: TIMELINE })).ok, false);
    assert.equal((await writeAlignment({ key: 'id:x', timeline: { lines: [] } })).ok, false);
  });

  test('overwrites an existing sidecar in place', async () => {
    const audioPath = path.join(music, 'Song.mp3');
    await writeAlignment({ key: 'id:abc', audioPath, alignVersion: 1, timeline: TIMELINE });
    await writeAlignment({ key: 'id:abc', audioPath, alignVersion: 5, timeline: TIMELINE });

    const files = (await fs.readdir(music)).filter((n) => n.endsWith(SIDECAR_EXT));
    assert.equal(files.length, 1, 'one sidecar, not two');
    const found = await readAlignment({ key: 'id:abc', audioPath });
    assert.equal(found.entry.alignVersion, 5);
  });
});

describe('readAlignment', () => {
  test('prefers the sibling file over the store', async () => {
    const audioPath = path.join(music, 'Song.mp3');
    await writeAlignment({ key: 'id:abc', timeline: TIMELINE, alignVersion: 1 });
    await writeAlignment({ key: 'id:abc', audioPath, timeline: TIMELINE, alignVersion: 7 });

    const found = await readAlignment({ key: 'id:abc', audioPath });
    assert.equal(found.from, 'sibling');
    assert.equal(found.entry.alignVersion, 7);
  });

  test('falls back to the store when there is no sibling', async () => {
    await writeAlignment({ key: 'id:abc', timeline: TIMELINE });
    const found = await readAlignment({ key: 'id:abc', audioPath: path.join(music, 'Song.mp3') });
    assert.equal(found.from, 'store');
  });

  test('returns null for an unknown track', async () => {
    assert.equal(await readAlignment({ key: 'id:nope' }), null);
    assert.equal(await readAlignment({}), null);
  });

  test('returns null for a corrupt sidecar instead of throwing', async () => {
    const audioPath = path.join(music, 'Song.mp3');
    await fs.writeFile(path.join(music, `Song${SIDECAR_EXT}`), '{not json', 'utf8');
    assert.equal(await readAlignment({ audioPath }), null);
  });

  test('returns null for a well-formed file with no lines', async () => {
    const audioPath = path.join(music, 'Song.mp3');
    await fs.writeFile(
      path.join(music, `Song${SIDECAR_EXT}`),
      JSON.stringify({ schema: 1, timeline: { lines: [] } }),
      'utf8'
    );
    assert.equal(await readAlignment({ audioPath }), null);
  });

  test('refuses an oversized file rather than parsing it', async () => {
    const audioPath = path.join(music, 'Song.mp3');
    await fs.writeFile(path.join(music, `Song${SIDECAR_EXT}`), 'x'.repeat(5 * 1024 * 1024), 'utf8');
    assert.equal(await readAlignment({ audioPath }), null);
  });

  test('different keys do not collide in the store', async () => {
    await writeAlignment({ key: 'id:aaa', timeline: TIMELINE, alignVersion: 1 });
    await writeAlignment({ key: 'id:bbb', timeline: TIMELINE, alignVersion: 2 });
    assert.equal((await readAlignment({ key: 'id:aaa' })).entry.alignVersion, 1);
    assert.equal((await readAlignment({ key: 'id:bbb' })).entry.alignVersion, 2);
  });
});
