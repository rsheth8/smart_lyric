import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKey,
  serializeTimeline,
  applyCachedTiming,
  ALIGN_VERSION,
} from '../app/timeline-cache.js';
import { needsVocalAlign, isWordSyncFormat, alignableWordTexts } from '../app/align.js';

describe('timeline-cache', () => {
  test('prefers Spotify/provider ids for cache keys', () => {
    assert.equal(cacheKey({ spotifyId: 'abc', track: 'Yellow' }), 'id:abc');
    assert.equal(cacheKey({ id: 'xyz', track: 'Yellow' }), 'id:xyz');
  });

  test('falls back to normalized artist|track|duration', () => {
    const key = cacheKey({ artist: 'Coldplay', track: 'Yellow', duration: 269.4 });
    assert.equal(key, 't:coldplay|yellow|269');
  });

  test('returns null without a track', () => {
    assert.equal(cacheKey({ artist: 'x' }), null);
  });

  test('applies cached word timings when structure matches', () => {
    const timeline = {
      lines: [
        {
          start: 1,
          end: 3,
          words: [
            { text: 'hello', start: 1, end: 2 },
            { text: 'world', start: 2, end: 3 },
          ],
        },
      ],
    };
    const cached = serializeTimeline({
      aligned: true,
      lines: [
        {
          start: 1.05,
          end: 3,
          words: [
            { text: 'hello', start: 1.1, end: 1.8 },
            { text: 'world', start: 1.8, end: 2.9 },
          ],
        },
      ],
    });
    assert.equal(applyCachedTiming(timeline, cached), true);
    assert.equal(timeline.aligned, true);
    assert.equal(timeline.lines[0].words[0].start, 1.1);
    assert.equal(timeline.lines[0]._vocalAligned, true);
  });

  test('rejects cache when word text diverges', () => {
    const timeline = {
      lines: [{ start: 0, end: 2, words: [{ text: 'hello', start: 0, end: 2 }] }],
    };
    const cached = {
      lines: [{ start: 0, end: 2, words: [{ text: 'goodbye', start: 0.2, end: 1.8 }] }],
    };
    assert.equal(applyCachedTiming(timeline, cached), false);
    assert.equal(timeline.aligned, undefined);
  });
});

describe('align helpers', () => {
  test('treats yrc/richsync/ass as word sync', () => {
    assert.equal(isWordSyncFormat('yrc'), true);
    assert.equal(isWordSyncFormat('lrc'), false);
  });

  test('needsVocalAlign skips catalog word sync and already-aligned', () => {
    const tl = { lines: [{ words: [{ text: 'a' }] }] };
    assert.equal(needsVocalAlign(tl, { format: 'lrc' }), true);
    assert.equal(needsVocalAlign(tl, { format: 'yrc' }), false);
    const done = {
      lines: [{ words: [{ text: 'a' }], _vocalAligned: true }],
      aligned: true,
    };
    assert.equal(needsVocalAlign(done, { format: 'lrc' }), false);
  });

  test('alignableWordTexts prefers romanization for non-Latin lines', () => {
    const line = {
      roman: 'namaste duniya',
      words: [{ text: 'नमस्ते' }, { text: 'दुनिया' }],
    };
    assert.deepEqual(alignableWordTexts(line), ['namaste', 'duniya']);
  });

  test('alignableWordTexts keeps Latin lyrics as-is', () => {
    const line = {
      roman: 'ignored',
      words: [{ text: 'Hello' }, { text: 'world' }],
    };
    assert.deepEqual(alignableWordTexts(line), ['Hello', 'world']);
  });
});

test('ALIGN_VERSION is a positive integer', () => {
  assert.equal(typeof ALIGN_VERSION, 'number');
  assert.ok(ALIGN_VERSION >= 1);
});
