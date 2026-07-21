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

// ---- warm-start prior strength -------------------------------------------

test('a previously-tuned track is always a strong prior', () => {
  rememberOffset(trackA, 0.3, { fromLock: true });
  const r = resolveOffset(trackA);
  assert.equal(r.source, 'track');
  assert.equal(r.strong, true, 'this exact song was tuned — trust it');
});

test('a device default is only strong once the path is learned', () => {
  // One lock: device default exists but the path is barely seen.
  rememberOffset(trackA, 0.3, { fromLock: true });
  const early = resolveOffset(trackB); // different track → falls back to device default
  assert.equal(early.source, 'device');
  assert.equal(early.strong, false, 'one data point is a guess, not a warm-start anchor');

  // A couple more locks on other tracks train the path.
  rememberOffset({ track: 'C', duration: 100 }, 0.3, { fromLock: true });
  rememberOffset({ track: 'D', duration: 100 }, 0.3, { fromLock: true });
  const trained = resolveOffset({ track: 'E', duration: 100 });
  assert.equal(trained.source, 'device');
  assert.equal(trained.strong, true, 'learned path → trustworthy default');
});

test('no memory at all is not strong', () => {
  const r = resolveOffset({ track: 'Never', duration: 100 });
  assert.equal(r.source, 'zero');
  assert.equal(r.strong, false);
});
