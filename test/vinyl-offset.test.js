import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VinylDetector } from '../app/vinyl.js';

function fakeClock() {
  return {
    observations: [],
    calibrations: [],
    playing: false,
    pauses: 0,
    observe(p) { this.observations.push(p); this.playing = true; },
    calibrateRate(s1, w1, s2, w2) { this.calibrations.push([s1, w1, s2, w2]); },
    isPlaying() { return this.playing; },
    pause() { this.pauses++; this.playing = false; },
  };
}

const match = (id, extra = {}) => ({ recordingId: id, title: 't' + id, artist: 'a', score: 0.9, ...extra });

test('uses offsetSec when provided by fingerprint', async () => {
  const clock = fakeClock();
  const det = new VinylDetector({
    identify: async () => match('A', { offsetSec: 125 }),
    getChunk: async () => ({ wav: 'w', onsetAt: 90 }),
    clock,
    onSong: async () => {},
    now: () => 100,
  });
  await det.pollOnce();
  assert.deepEqual(clock.observations, [125]);
});

test('calibrateRate called on repeat observations', async () => {
  const clock = fakeClock();
  const queue = [match('A', { offsetSec: 10 }), match('A', { offsetSec: 15 })];
  const det = new VinylDetector({
    identify: async () => queue.shift(),
    getChunk: async () => ({ wav: 'w', onsetAt: 0 }),
    clock,
    onSong: async () => {},
    now: () => { det._t = (det._t ?? 100) + 5; return det._t; },
  });
  await det.pollOnce();
  await det.pollOnce();
  assert.equal(clock.calibrations.length, 1);
});
