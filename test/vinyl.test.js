import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VinylDetector } from '../app/vinyl.js';

function fakeClock() {
  return {
    observations: [],
    playing: false,
    pauses: 0,
    observe(p) { this.observations.push(p); this.playing = true; },
    isPlaying() { return this.playing; },
    pause() { this.pauses++; this.playing = false; },
  };
}

// Build a detector whose identify() returns queued results in order.
function make({ results, onsetAt = 90, now = 100, missTolerance = 2, minScore = 0.5 }) {
  const clock = fakeClock();
  const songs = [];
  const states = [];
  const queue = [...results];
  const det = new VinylDetector({
    identify: async () => (queue.length ? queue.shift() : null),
    getChunk: async () => ({ wav: 'wav', onsetAt }),
    clock,
    onSong: async (m) => songs.push(m),
    onState: (s) => states.push(s),
    now: () => now,
    missTolerance,
    minScore,
  });
  return { det, clock, songs, states };
}

const match = (id, extra = {}) => ({ recordingId: id, title: 't' + id, artist: 'a', score: 0.9, ...extra });

test('first match locks on, prepares the song, and starts the clock at now - onset', async () => {
  const { det, clock, songs } = make({ results: [match('A')], now: 100, onsetAt: 90 });
  await det.pollOnce();
  assert.equal(det.state, 'locked');
  assert.equal(det.currentId, 'A');
  assert.equal(songs.length, 1);
  assert.deepEqual(clock.observations, [10]); // 100 - 90
});

test('a repeat of the same song refines position without re-preparing', async () => {
  const { det, clock, songs } = make({ results: [match('A'), match('A')] });
  await det.pollOnce();
  await det.pollOnce();
  assert.equal(songs.length, 1); // onSong only once
  assert.equal(clock.observations.length, 2); // but position observed twice
});

test('a different song re-prepares and switches the lock', async () => {
  const { det, songs } = make({ results: [match('A'), match('B')] });
  await det.pollOnce();
  await det.pollOnce();
  assert.equal(det.currentId, 'B');
  assert.equal(songs.length, 2);
  assert.deepEqual(songs.map((s) => s.recordingId), ['A', 'B']);
});

test('low-confidence matches are ignored', async () => {
  const { det, songs } = make({ results: [match('A', { score: 0.2 })], minScore: 0.5 });
  await det.pollOnce();
  assert.notEqual(det.state, 'locked'); // never locked
  assert.equal(songs.length, 0);
});

test('losing the signal releases the lock after missTolerance misses', async () => {
  const { det, clock, states } = make({ results: [match('A'), null, null], missTolerance: 2 });
  await det.pollOnce(); // lock
  assert.equal(det.state, 'locked');
  await det.pollOnce(); // miss 1
  assert.equal(det.state, 'locked');
  await det.pollOnce(); // miss 2 → release
  assert.equal(det.state, 'listening');
  assert.equal(det.currentId, null);
  assert.ok(clock.pauses >= 1);
  assert.ok(states.includes('locked') && states.lastIndexOf('listening') > states.indexOf('locked'));
});

test('an identify() failure is treated as a miss, not a crash', async () => {
  const clock = fakeClock();
  const det = new VinylDetector({
    identify: async () => { throw new Error('network'); },
    getChunk: async () => ({ wav: 'w', onsetAt: 0 }),
    clock,
    onSong: async () => {},
    now: () => 5,
    missTolerance: 1,
  });
  const r = await det.pollOnce();
  assert.equal(r, null);
  assert.equal(det.state, 'idle'); // was never locked, miss is a no-op
});

test('no audio onset yet → poll does nothing', async () => {
  const clock = fakeClock();
  let called = false;
  const det = new VinylDetector({
    identify: async () => { called = true; return match('A'); },
    getChunk: async () => null, // mic hasn't heard the record start
    clock,
    onSong: async () => {},
    now: () => 1,
  });
  const r = await det.pollOnce();
  assert.equal(r, null);
  assert.equal(called, false); // never even fingerprinted
  assert.equal(clock.observations.length, 0);
});
