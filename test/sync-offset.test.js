import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  trackKey,
  resolveOffset,
  rememberOffset,
  clearTrackOffset,
  resetAllOffsets,
  getDeviceDefault,
  getPathSamples,
  devicePriorWeight,
} from '../app/sync-offset.js';

// localStorage shim for Node tests
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

describe('sync-offset', () => {
  test('trackKey prefers Spotify id', () => {
    assert.equal(trackKey({ spotifyId: 'abc', track: 'X' }), 'id:abc');
    assert.equal(trackKey({ artist: 'A', track: 'Hello', duration: 200.4 }), 't:a|hello|200');
  });

  test('rememberOffset stores per-track and updates device default', () => {
    resetAllOffsets();
    rememberOffset({ spotifyId: 'song1', track: 'One' }, -0.8);
    const r = resolveOffset({ spotifyId: 'song1' });
    assert.equal(r.source, 'track');
    assert.equal(r.offset, -0.8);
    // Device default moves toward the nudge (EMA).
    assert.ok(getDeviceDefault() < 0);
  });

  test('new songs fall back to device default', () => {
    resetAllOffsets();
    rememberOffset({ spotifyId: 'known', track: 'A' }, -0.5);
    const r = resolveOffset({ spotifyId: 'unknown', track: 'B' });
    assert.equal(r.source, 'device');
    assert.ok(r.offset < 0);
  });

  test('clearTrackOffset falls back to device default', () => {
    resetAllOffsets();
    rememberOffset({ spotifyId: 'x', track: 'X' }, -0.6);
    clearTrackOffset({ spotifyId: 'x' });
    const r = resolveOffset({ spotifyId: 'x' });
    assert.equal(r.source, 'device');
  });

  test('mic locks strengthen the device prior after a couple of songs', () => {
    resetAllOffsets();
    assert.equal(devicePriorWeight(), 0.75);
    rememberOffset({ spotifyId: 'a', track: 'A' }, -0.5, { fromLock: true });
    rememberOffset({ spotifyId: 'a', track: 'A' }, -0.52, { fromLock: true }); // same song — once
    assert.equal(getPathSamples(), 1);
    assert.equal(devicePriorWeight(), 1.0);
    rememberOffset({ spotifyId: 'b', track: 'B' }, -0.55, { fromLock: true });
    assert.equal(getPathSamples(), 2);
    assert.ok(devicePriorWeight() > 1.0);
  });
});
