import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  importEntry,
  exportEntry,
  sanitizeCachedTimeline,
  getCachedTimeline,
  putCachedTimeline,
  serializeTimeline,
  ALIGN_VERSION,
  STORE_VERSION,
} from '../app/timeline-cache.js';
import { sidecarAvailable, hydrateFromSidecar, saveToSidecar } from '../app/sidecar.js';

const STORAGE_KEY = 'bar4bar.alignCache.v2';

function installStorage(seed) {
  const map = new Map();
  if (seed != null) map.set(STORAGE_KEY, JSON.stringify(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

function goodTimeline() {
  return {
    duration: 14,
    aligned: true,
    lines: [
      {
        start: 10,
        end: 14,
        words: [
          { text: 'one', start: 10, end: 12, conf: 0.9 },
          { text: 'two', start: 12, end: 14, conf: 0.8 },
        ],
      },
    ],
  };
}

describe('sanitizeCachedTimeline', () => {
  test('accepts a well-formed timeline and whitelists fields', () => {
    const out = sanitizeCachedTimeline({
      ...goodTimeline(),
      evil: 'dropped',
      lines: [{ ...goodTimeline().lines[0], evil: 'dropped', agent: 'v1' }],
    });
    assert.ok(out);
    assert.equal(out.evil, undefined);
    assert.equal(out.lines[0].evil, undefined);
    assert.equal(out.lines[0].agent, 'v1');
    assert.equal(out.lines[0].words[0].conf, 0.9);
  });

  test('rejects non-timelines and empty line lists', () => {
    assert.equal(sanitizeCachedTimeline(null), null);
    assert.equal(sanitizeCachedTimeline({ lines: [] }), null);
    assert.equal(sanitizeCachedTimeline({ lines: 'nope' }), null);
    assert.equal(sanitizeCachedTimeline('nope'), null);
  });

  test('rejects non-finite and missing timings', () => {
    assert.equal(
      sanitizeCachedTimeline({ lines: [{ start: 'x', words: [] }] }),
      null
    );
    assert.equal(
      sanitizeCachedTimeline({
        lines: [{ start: 0, end: 1, words: [{ text: 'a', start: Infinity, end: 1 }] }],
      }),
      null
    );
    assert.equal(
      sanitizeCachedTimeline({ lines: [{ start: 0, end: 1, words: [{ start: 0, end: 1 }] }] }),
      null,
      'a word with no text is not a word'
    );
  });

  test('rejects absurd sizes rather than trying to render them', () => {
    const words = Array.from({ length: 5000 }, (_, i) => ({ text: 'x', start: i, end: i + 1 }));
    assert.equal(sanitizeCachedTimeline({ lines: [{ start: 0, end: 1, words }] }), null);
  });

  test('truncates over-long text instead of trusting it', () => {
    const out = sanitizeCachedTimeline({
      lines: [{ start: 0, end: 1, words: [{ text: 'x'.repeat(10000), start: 0, end: 1 }] }],
    });
    assert.ok(out.lines[0].words[0].text.length <= 400);
  });

  test('keeps sections, agents and background vocals', () => {
    const out = sanitizeCachedTimeline({
      ...goodTimeline(),
      agents: [{ id: 'v1', name: 'Adele' }, { name: 'no id' }],
      sections: [{ part: 'Chorus', start: 10, end: 14 }, { start: 1 }],
      lines: [
        {
          ...goodTimeline().lines[0],
          bg: [{ start: 13, end: 14, words: [{ text: 'ooh', start: 13, end: 14 }] }],
        },
      ],
    });
    assert.deepEqual(out.agents.map((a) => a.id), ['v1']);
    assert.deepEqual(out.sections.map((s) => s.part), ['Chorus']);
    assert.equal(out.lines[0].bg[0].words[0].text, 'ooh');
  });
});

describe('importEntry', () => {
  beforeEach(() => installStorage(null));
  afterEach(() => {
    delete globalThis.localStorage;
  });

  test('imports a sidecar entry into the local store', () => {
    assert.equal(
      importEntry('id:abc', { timeline: goodTimeline(), alignVersion: ALIGN_VERSION, savedAt: 100 }),
      true
    );
    const got = getCachedTimeline('id:abc');
    assert.equal(got.timeline.lines[0].words[0].start, 10);
    assert.equal(got.alignVersion, ALIGN_VERSION);
    assert.equal(got.stale, false);
  });

  test('refuses a malformed sidecar', () => {
    assert.equal(importEntry('id:abc', { timeline: { lines: [{ start: 'x' }] } }), false);
    assert.equal(importEntry('id:abc', {}), false);
    assert.equal(getCachedTimeline('id:abc'), null);
  });

  test('a newer aligner wins over a newer save', () => {
    installStorage({
      v: STORE_VERSION,
      entries: {
        'id:abc': { savedAt: 9999, alignVersion: ALIGN_VERSION, timeline: goodTimeline() },
      },
    });
    assert.equal(
      importEntry('id:abc', {
        timeline: goodTimeline(),
        alignVersion: ALIGN_VERSION - 1,
        savedAt: 100000,
      }),
      false,
      'older aligner rejected even though it was saved later'
    );
    assert.equal(
      importEntry('id:abc', {
        timeline: goodTimeline(),
        alignVersion: ALIGN_VERSION + 1,
        savedAt: 1,
      }),
      true,
      'newer aligner accepted even though it was saved earlier'
    );
  });

  test('same aligner: the newer save wins, a re-import is a no-op', () => {
    importEntry('id:abc', { timeline: goodTimeline(), alignVersion: ALIGN_VERSION, savedAt: 500 });
    assert.equal(
      importEntry('id:abc', { timeline: goodTimeline(), alignVersion: ALIGN_VERSION, savedAt: 500 }),
      false
    );
    assert.equal(
      importEntry('id:abc', { timeline: goodTimeline(), alignVersion: ALIGN_VERSION, savedAt: 600 }),
      true
    );
  });
});

describe('exportEntry', () => {
  beforeEach(() => installStorage(null));
  afterEach(() => {
    delete globalThis.localStorage;
  });

  test('round-trips a saved alignment', () => {
    putCachedTimeline('id:abc', { ...goodTimeline(), aligned: true }, { artist: 'A', track: 'B' });
    const out = exportEntry('id:abc');
    assert.equal(out.key, 'id:abc');
    assert.equal(out.alignVersion, ALIGN_VERSION);
    assert.equal(out.meta.artist, 'A');
    assert.equal(out.timeline.lines[0].words[1].text, 'two');
  });

  test('export → import is lossless across a fresh store', () => {
    putCachedTimeline('id:abc', { ...goodTimeline(), aligned: true }, { artist: 'A', track: 'B' });
    const exported = exportEntry('id:abc');

    installStorage(null); // simulate a cache clear / new machine
    assert.equal(getCachedTimeline('id:abc'), null);
    assert.equal(importEntry('id:abc', exported), true);

    // Sanitize drops explicitly-false flags, so compare substance, not shape.
    const back = getCachedTimeline('id:abc').timeline;
    assert.deepEqual(back.lines, exported.timeline.lines);
    assert.equal(back.duration, exported.timeline.duration);
    assert.equal(back.aligned, exported.timeline.aligned);
  });

  test('returns null for an unknown key', () => {
    assert.equal(exportEntry('id:nope'), null);
  });
});

describe('sidecar bridge', () => {
  beforeEach(() => {
    installStorage(null);
    delete globalThis.window;
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
  });

  test('no-ops without the Electron bridge (web build)', async () => {
    assert.equal(sidecarAvailable(), false);
    assert.deepEqual(await hydrateFromSidecar({ key: 'id:abc' }), { imported: false });
    assert.deepEqual(await saveToSidecar({ key: 'id:abc' }), { ok: false });
  });

  test('hydrate imports what the bridge returns', async () => {
    const calls = [];
    globalThis.window = {
      bar4bar: {
        readAlignment: async (payload) => {
          calls.push(payload);
          return {
            from: 'sibling',
            entry: { key: 'id:abc', alignVersion: ALIGN_VERSION, savedAt: 5, timeline: goodTimeline() },
          };
        },
      },
    };
    const res = await hydrateFromSidecar({
      key: 'id:abc',
      audioFile: { path: '/music/Song.mp3' },
    });
    assert.deepEqual(res, { imported: true, from: 'sibling' });
    assert.deepEqual(calls, [{ key: 'id:abc', audioPath: '/music/Song.mp3' }]);
    assert.ok(getCachedTimeline('id:abc'));
  });

  test('hydrate survives a throwing or malformed bridge', async () => {
    globalThis.window = { bar4bar: { readAlignment: async () => { throw new Error('EIO'); } } };
    assert.deepEqual(await hydrateFromSidecar({ key: 'id:abc' }), { imported: false });

    globalThis.window = {
      bar4bar: { readAlignment: async () => ({ from: 'store', entry: { timeline: { lines: 'no' } } }) },
    };
    assert.equal((await hydrateFromSidecar({ key: 'id:abc' })).imported, false);
    assert.equal(getCachedTimeline('id:abc'), null);
  });

  test('a sibling sidecar is stored under the key being loaded, not its own', async () => {
    globalThis.window = {
      bar4bar: {
        readAlignment: async () => ({
          from: 'sibling',
          entry: { key: 'id:stale-key-from-another-machine', savedAt: 5, timeline: goodTimeline() },
        }),
      },
    };
    await hydrateFromSidecar({ key: 'id:mine', audioFile: { path: '/music/Song.mp3' } });
    assert.ok(getCachedTimeline('id:mine'));
    assert.equal(getCachedTimeline('id:stale-key-from-another-machine'), null);
  });

  test('save forwards the stored entry and the audio path', async () => {
    const writes = [];
    globalThis.window = {
      bar4bar: {
        readAlignment: async () => null,
        writeAlignment: async (payload) => {
          writes.push(payload);
          return { ok: true, store: true, sibling: true };
        },
      },
    };
    putCachedTimeline('id:abc', { ...goodTimeline(), aligned: true }, { artist: 'A', track: 'B' });
    const res = await saveToSidecar({ key: 'id:abc', audioFile: { path: '/music/Song.mp3' } });

    assert.equal(res.ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, 'id:abc');
    assert.equal(writes[0].audioPath, '/music/Song.mp3');
    assert.equal(writes[0].alignVersion, ALIGN_VERSION);
    assert.equal(writes[0].timeline.lines[0].words[0].text, 'one');
  });

  test('save omits the audio path when the File has none (web-origin file)', async () => {
    const writes = [];
    globalThis.window = {
      bar4bar: {
        readAlignment: async () => null,
        writeAlignment: async (p) => (writes.push(p), { ok: true }),
      },
    };
    putCachedTimeline('id:abc', { ...goodTimeline(), aligned: true }, {});
    await saveToSidecar({ key: 'id:abc', audioFile: { name: 'Song.mp3' } });
    assert.equal(writes[0].audioPath, undefined);
  });

  test('save skips a key with nothing stored', async () => {
    globalThis.window = {
      bar4bar: { readAlignment: async () => null, writeAlignment: async () => ({ ok: true }) },
    };
    assert.deepEqual(await saveToSidecar({ key: 'id:missing' }), { ok: false });
  });
});

describe('sidecar payload shape', () => {
  test('serializeTimeline output passes sanitize unchanged in substance', () => {
    const serialized = serializeTimeline({
      ...goodTimeline(),
      agents: [{ id: 'v1', name: 'Adele' }],
      sections: [{ part: 'Verse', start: 10, end: 14 }],
    });
    const clean = sanitizeCachedTimeline(serialized);
    assert.ok(clean);
    assert.equal(clean.lines.length, serialized.lines.length);
    assert.deepEqual(
      clean.lines[0].words.map((w) => w.text),
      serialized.lines[0].words.map((w) => w.text)
    );
    assert.deepEqual(clean.sections, serialized.sections);
  });
});
