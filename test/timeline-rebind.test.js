import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCachedTiming,
  rebindCachedTiming,
  lcsPairs,
  serializeTimeline,
  getCachedTimeline,
  putCachedTimeline,
  ALIGN_VERSION,
  STORE_VERSION,
} from '../app/timeline-cache.js';
import { needsVocalAlign } from '../app/align.js';

const STORAGE_KEY = 'bar4bar.alignCache.v2';

/** Minimal localStorage so the cache module is testable in node. */
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

/** Build a timeline from `[[start, end, 'a b c'], ...]`. */
function makeTimeline(spec) {
  const lines = spec.map(([start, end, text]) => {
    const tokens = text.split(' ');
    const step = (end - start) / tokens.length;
    return {
      start,
      end,
      words: tokens.map((t, i) => ({
        text: t,
        start: start + i * step,
        end: start + (i + 1) * step,
      })),
    };
  });
  return { lines, duration: lines[lines.length - 1].end };
}

describe('lcsPairs', () => {
  test('matches the common subsequence in order', () => {
    const pairs = lcsPairs(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']);
    assert.deepEqual(pairs, [[0, 0], [2, 2], [3, 3]]);
  });

  test('handles empty input', () => {
    assert.deepEqual(lcsPairs([], ['a']), []);
    assert.deepEqual(lcsPairs(['a'], []), []);
  });
});

describe('rebindCachedTiming', () => {
  test('survives a punctuation-only lyric revision', () => {
    const aligned = makeTimeline([[10, 14, 'i heard that you']]);
    // Aligner refined the words away from the even spread.
    aligned.lines[0].words[0].start = 10.0;
    aligned.lines[0].words[1].start = 10.9;
    aligned.lines[0].words[2].start = 11.4;
    aligned.lines[0].words[3].start = 13.2;
    const cached = serializeTimeline({ ...aligned, aligned: true });

    // Provider re-fetch: same words, different punctuation/case.
    const fresh = makeTimeline([[10, 14, 'I heard, that you']]);
    assert.equal(applyCachedTiming(fresh, cached), true);
    assert.equal(fresh.lines[0].words[1].start, 10.9);
    assert.equal(fresh.lines[0].words[3].start, 13.2);
    assert.equal(fresh.lines[0]._vocalAligned, true);
  });

  test('a split stanza keeps timings across the new line boundary', () => {
    const aligned = makeTimeline([[10, 18, 'one two three four five six']]);
    const cached = serializeTimeline({ ...aligned, aligned: true });

    const fresh = makeTimeline([
      [10, 14, 'one two three'],
      [14, 18, 'four five six'],
    ]);
    assert.equal(applyCachedTiming(fresh, cached), true);
    // Every word matched, so both lines are aligned and carry cached spans.
    assert.equal(fresh.lines[0]._vocalAligned, true);
    assert.equal(fresh.lines[1]._vocalAligned, true);
    assert.equal(fresh.lines[1].words[0].start, cached.lines[0].words[3].start);
  });

  test('an edited word is interpolated and its line left unaligned', () => {
    const aligned = makeTimeline([
      [10, 14, 'one two three'],
      [14, 18, 'four five six'],
    ]);
    const cached = serializeTimeline({ ...aligned, aligned: true });

    const fresh = makeTimeline([
      [10, 14, 'one two three'],
      [14, 18, 'four FIVEISH six'],
    ]);
    assert.equal(applyCachedTiming(fresh, cached), true);
    assert.equal(fresh.lines[0]._vocalAligned, true, 'clean line stays aligned');
    assert.equal(fresh.lines[1]._vocalAligned, undefined, 'edited line reopens');
    // The edited word sits between its surviving neighbours.
    const line = fresh.lines[1];
    assert.ok(line.words[1].start >= line.words[0].end - 1e-6);
    assert.ok(line.words[1].end <= line.words[2].start + 1e-6);
    assert.equal(line.words[1].conf, 0, 'interpolated words are not observed');
    // ...and the aligner knows there is work left to do.
    assert.equal(needsVocalAlign(fresh, { format: 'lrc' }), true);
  });

  test('rejects a cache for different lyrics entirely', () => {
    const cached = serializeTimeline({
      ...makeTimeline([[10, 14, 'alpha bravo charlie delta']]),
      aligned: true,
    });
    const fresh = makeTimeline([[10, 14, 'nothing like the original']]);
    assert.equal(applyCachedTiming(fresh, cached), false);
    assert.equal(fresh.aligned, undefined);
  });

  test('rejects a cache from a different recording', () => {
    const cached = serializeTimeline({
      ...makeTimeline([[120, 126, 'one two three four']]),
      aligned: true,
    });
    const fresh = makeTimeline([[10, 16, 'one two three FOUR']]);
    assert.equal(rebindCachedTiming(fresh, cached), false);
  });

  test('exact-structure matches never reach the rebind path', () => {
    const cached = serializeTimeline({
      ...makeTimeline([[10, 14, 'one two three']]),
      aligned: true,
    });
    const fresh = makeTimeline([[10, 14, 'one two three']]);
    assert.equal(applyCachedTiming(fresh, cached, { rebind: false }), true);
    assert.equal(fresh.rebound, undefined);
  });
});

describe('provisional (stale-aligner) entries', () => {
  test('spans are applied but lines stay open for re-alignment', () => {
    const cached = serializeTimeline({
      ...makeTimeline([[10, 14, 'one two three']]),
      aligned: true,
    });
    const fresh = makeTimeline([[10, 14, 'one two three']]);
    fresh.lines[0].words[1].start = 99; // prove the spans really land

    assert.equal(applyCachedTiming(fresh, cached, { provisional: true }), true);
    assert.equal(fresh.lines[0].words[1].start, cached.lines[0].words[1].start);
    assert.equal(fresh.provisional, true);
    assert.equal(fresh.aligned, undefined);
    assert.equal(fresh.lines[0]._vocalAligned, undefined);
    assert.equal(needsVocalAlign(fresh, { format: 'lrc' }), true);
  });
});

describe('store versioning', () => {
  beforeEach(() => {
    delete globalThis.localStorage;
  });

  test('migrates a v2 store instead of discarding it', () => {
    const tl = serializeTimeline({ ...makeTimeline([[10, 14, 'one two']]), aligned: true });
    installStorage({ v: 2, entries: { 'id:abc': { savedAt: 1, timeline: tl } } });

    const entry = getCachedTimeline('id:abc');
    assert.ok(entry, 'v2 entry survived the upgrade');
    assert.equal(entry.alignVersion, 2);
    assert.equal(entry.stale, ALIGN_VERSION > 2);
  });

  test('stamps the aligner version on write and reports staleness', () => {
    const map = installStorage(null);
    const timeline = { ...makeTimeline([[10, 14, 'one two']]), aligned: true };
    assert.equal(putCachedTimeline('id:xyz', timeline, { artist: 'A', track: 'B' }), true);

    const stored = JSON.parse(map.get(STORAGE_KEY));
    assert.equal(stored.v, STORE_VERSION);
    assert.equal(stored.entries['id:xyz'].alignVersion, ALIGN_VERSION);
    assert.equal(getCachedTimeline('id:xyz').stale, false);
  });

  test('an entry from an older aligner is flagged stale, not dropped', () => {
    const tl = serializeTimeline({ ...makeTimeline([[10, 14, 'one two']]), aligned: true });
    installStorage({
      v: STORE_VERSION,
      entries: { 'id:old': { savedAt: 1, alignVersion: ALIGN_VERSION - 1, timeline: tl } },
    });

    const entry = getCachedTimeline('id:old');
    assert.ok(entry);
    assert.equal(entry.stale, true);
  });

  test('unknown store versions are still discarded', () => {
    installStorage({ v: 99, entries: { 'id:abc': { savedAt: 1, timeline: { lines: [{}] } } } });
    assert.equal(getCachedTimeline('id:abc'), null);
  });
});

describe('serializeTimeline extras', () => {
  test('round-trips agents, sections, bg and per-word confidence', () => {
    const out = serializeTimeline({
      aligned: true,
      duration: 20,
      agents: [{ id: 'v1', name: 'Adele' }],
      sections: [{ part: 'Verse', start: 10, end: 14 }],
      lines: [
        {
          start: 10,
          end: 14,
          agent: 'v1',
          translation: 'hola',
          words: [{ text: 'one', start: 10, end: 12, conf: 0.8765 }],
          bg: [{ start: 13, end: 14, words: [{ text: 'ooh', start: 13, end: 14 }] }],
        },
      ],
    });
    assert.deepEqual(out.agents, [{ id: 'v1', name: 'Adele' }]);
    assert.deepEqual(out.sections, [{ part: 'Verse', start: 10, end: 14 }]);
    assert.equal(out.lines[0].agent, 'v1');
    assert.equal(out.lines[0].translation, 'hola');
    assert.equal(out.lines[0].words[0].conf, 0.877);
    assert.equal(out.lines[0].bg[0].words[0].text, 'ooh');
  });

  test('carries structure onto a timeline that lacks it', () => {
    const cached = serializeTimeline({
      aligned: true,
      agents: [{ id: 'v1', name: 'Adele' }],
      sections: [{ part: 'Chorus', start: 10, end: 14 }],
      lines: [{ start: 10, end: 14, words: [{ text: 'one', start: 10, end: 14 }] }],
    });
    const fresh = makeTimeline([[10, 14, 'one']]);
    assert.equal(applyCachedTiming(fresh, cached), true);
    assert.equal(fresh.agents[0].name, 'Adele');
    assert.equal(fresh.sections[0].part, 'Chorus');
  });
});
