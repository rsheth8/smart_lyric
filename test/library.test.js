import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, rankRecent, relativeWhen } from '../app/library.js';

const adele = { artist: 'Adele', track: 'Someone Like You', duration: 285 };
const nirvana = { artist: 'Nirvana', track: 'Smells Like Teen Spirit', duration: 301 };

describe('library — addEntry', () => {
  test('adds a first play, most-recent-first', () => {
    const out = addEntry([], adele, { now: 1000 });
    assert.equal(out.length, 1);
    assert.equal(out[0].track, 'Someone Like You');
    assert.equal(out[0].plays, 1);
    assert.equal(out[0].lastPlayedAt, 1000);
    assert.equal(out[0].key, 't:adele|someone like you|285');
  });

  test('dedupes by key — a replay moves to the front and counts up', () => {
    let list = addEntry([], adele, { now: 1000 });
    list = addEntry(list, nirvana, { now: 2000 });
    list = addEntry(list, adele, { now: 3000 });

    assert.equal(list.length, 2, 'no duplicate row');
    assert.equal(list[0].track, 'Someone Like You');
    assert.equal(list[0].plays, 2);
    assert.equal(list[0].lastPlayedAt, 3000);
    assert.equal(list[1].track, 'Smells Like Teen Spirit');
  });

  test('keeps artwork from an earlier play when this one has none', () => {
    // Spotify knows the cover; a later re-sync from a local file may not, and
    // the library row shouldn't lose its art because of that.
    let list = addEntry([], adele, { now: 1000, art: 'http://art/1.jpg' });
    list = addEntry(list, adele, { now: 2000 });
    assert.equal(list[0].art, 'http://art/1.jpg');
  });

  test('a newer play can replace the artwork', () => {
    let list = addEntry([], adele, { now: 1000, art: 'http://art/1.jpg' });
    list = addEntry(list, adele, { now: 2000, art: 'http://art/2.jpg' });
    assert.equal(list[0].art, 'http://art/2.jpg');
  });

  test('caps the list and drops the oldest', () => {
    let list = [];
    for (let i = 0; i < 10; i++) {
      list = addEntry(list, { artist: 'A', track: `T${i}` }, { now: i, max: 4 });
    }
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((e) => e.track), ['T9', 'T8', 'T7', 'T6']);
  });

  test('ignores a track with no usable cache key', () => {
    const out = addEntry([], { artist: 'Nobody' }, { now: 1 });
    assert.deepEqual(out, []);
  });

  test('does not mutate the input array', () => {
    const before = addEntry([], adele, { now: 1000 });
    const snapshot = JSON.parse(JSON.stringify(before));
    addEntry(before, nirvana, { now: 2000 });
    assert.deepEqual(before, snapshot);
  });

  test('a Spotify id keys separately from artist/track', () => {
    const out = addEntry([], { spotifyId: 'abc', artist: 'Adele', track: 'Someone Like You' }, { now: 1 });
    assert.equal(out[0].key, 'id:abc');
  });
});

describe('library — rankRecent', () => {
  test('sorts most-recent first regardless of stored order', () => {
    const scrambled = [
      { key: 'a', lastPlayedAt: 100 },
      { key: 'c', lastPlayedAt: 300 },
      { key: 'b', lastPlayedAt: 200 },
    ];
    assert.deepEqual(rankRecent(scrambled).map((e) => e.key), ['c', 'b', 'a']);
  });

  test('tolerates empty and missing timestamps', () => {
    assert.deepEqual(rankRecent([]), []);
    assert.deepEqual(rankRecent(undefined), []);
    assert.equal(rankRecent([{ key: 'x' }]).length, 1);
  });
});

describe('library — relativeWhen', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const ago = (ms) => relativeWhen(now - ms, now);

  test('labels each bucket', () => {
    assert.equal(ago(5 * 1000), 'just now');
    assert.equal(ago(10 * 60 * 1000), '10 min ago');
    assert.equal(ago(3 * 3600 * 1000), '3h ago');
    assert.equal(ago(30 * 3600 * 1000), 'yesterday');
    assert.equal(ago(4 * 24 * 3600 * 1000), '4 days ago');
    assert.equal(ago(14 * 24 * 3600 * 1000), '2 wk ago');
  });

  test('falls back to a date for anything older than a month', () => {
    assert.match(ago(200 * 24 * 3600 * 1000), /\w/);
    assert.doesNotMatch(ago(200 * 24 * 3600 * 1000), /ago|yesterday/);
  });

  test('never renders a negative age from clock skew', () => {
    assert.equal(relativeWhen(now + 60_000, now), 'just now');
  });
});
