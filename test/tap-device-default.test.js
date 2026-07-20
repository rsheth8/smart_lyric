import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rememberOffset, resolveOffset } from '../app/sync-offset.js';

// Minimal localStorage so sync-offset can persist between calls.
class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStore(),
    configurable: true,
    writable: true,
  });
});

const trackA = { artist: 'A', track: 'One', duration: 200 };
const trackB = { artist: 'B', track: 'Two', duration: 210 };

test('microphone measurements train the device default', () => {
  for (let i = 0; i < 6; i++) {
    rememberOffset(trackA, 0.35, { fromLock: true, trainsDevice: true });
  }
  // A brand-new track should now open near the learned speaker delay.
  const seeded = resolveOffset(trackB);
  assert.ok(seeded.offset > 0.1, `expected a learned default, got ${seeded.offset}`);
});

// A loopback tap reads the OS mixer BEFORE the output device, so it measures ~0
// speaker delay by construction. Letting that train the device default would
// erase a real Bluetooth/soundbar lag learned from a microphone.
test('digital-tap measurements do NOT erase a learned speaker delay', () => {
  for (let i = 0; i < 6; i++) {
    rememberOffset(trackA, 0.35, { fromLock: true, trainsDevice: true });
  }
  const beforeTap = resolveOffset(trackB).offset;

  // Now the user routes through BlackHole; the tap sees no output delay at all.
  for (let i = 0; i < 10; i++) {
    rememberOffset(trackA, 0.0, { fromLock: true, trainsDevice: false });
  }
  const afterTap = resolveOffset(trackB).offset;

  assert.ok(
    Math.abs(afterTap - beforeTap) < 1e-9,
    `device default must be untouched by tap measurements: ${beforeTap} → ${afterTap}`
  );
});

test('the per-track offset IS still stored from a tap (catalog-vs-audio is real)', () => {
  rememberOffset(trackA, 0.12, { fromLock: true, trainsDevice: false });
  const got = resolveOffset(trackA);
  assert.ok(Math.abs(got.offset - 0.12) < 1e-9, `per-track offset kept, got ${got.offset}`);
  assert.equal(got.source, 'track');
});

test('without the guard, a tap would drag the default toward zero', () => {
  for (let i = 0; i < 6; i++) rememberOffset(trackA, 0.35, { fromLock: true });
  const before = resolveOffset(trackB).offset;
  // trainsDevice defaults to true — this is the old behaviour.
  for (let i = 0; i < 10; i++) rememberOffset(trackA, 0.0, { fromLock: true });
  const after = resolveOffset(trackB).offset;
  assert.ok(after < before / 2, `sanity: unguarded training collapses it (${before} → ${after})`);
});
