import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncBlocker,
  syncDiagSummary,
  updateSyncDiag,
  resetSyncDiag,
  syncDiag,
  onSyncDiag,
} from '../app/sync-diag.js';

// A pipeline in perfect health, for tests to break one stage at a time.
const healthy = {
  capture: 'open',
  captureKind: 'mic',
  captureLabel: 'MacBook Pro Microphone',
  peakLevel: 0.2,
  clock: 'ok',
  loop: 'measuring',
  candidates: 2,
  onsetTried: 2,
  onsetFailed: 0,
  accepted: 2,
  clamped: 0,
  count: 4,
  confidence: 0.8,
  lock: 'converging',
};

beforeEach(() => {
  resetSyncDiag();
  onSyncDiag(null);
});

test('a locked pipeline reports no blocker', () => {
  assert.equal(syncBlocker({ ...healthy, lock: 'locked' }), null);
  assert.match(syncDiagSummary({ ...healthy, lock: 'locked' }), /locked/);
});

test('capture failure outranks everything downstream', () => {
  const b = syncBlocker({ ...healthy, capture: 'error', captureError: 'permission denied', peakLevel: 0 });
  assert.equal(b.stage, 'capture');
  assert.match(b.detail, /permission denied/);
});

// The reported bug: BlackHole opens fine but carries nothing.
test('a silent digital tap is named as such, not as generic "listening"', () => {
  const b = syncBlocker({ ...healthy, captureKind: 'loopback', peakLevel: 0 });
  assert.equal(b.stage, 'audio');
  assert.match(b.detail, /digital tap is silent/);
  assert.match(syncDiagSummary({ ...healthy, captureKind: 'loopback', peakLevel: 0 }), /silent/);
});

test('a silent microphone reads differently from a silent tap', () => {
  const b = syncBlocker({ ...healthy, captureKind: 'mic', peakLevel: 0 });
  assert.equal(b.stage, 'audio');
  assert.match(b.detail, /hearing nothing/);
});

test('a missing clock is reported', () => {
  assert.equal(syncBlocker({ ...healthy, clock: 'none' }).stage, 'clock');
});

test('a halted loop is reported', () => {
  assert.equal(syncBlocker({ ...healthy, loop: 'no-mic' }).stage, 'loop');
});

test('waiting for a finished line is a window issue, not a failure', () => {
  const b = syncBlocker({ ...healthy, candidates: 0, accepted: 0, count: 0 });
  assert.equal(b.stage, 'window');
});

test('onsets tried but never found is named', () => {
  const b = syncBlocker({ ...healthy, onsetTried: 5, onsetFailed: 5, accepted: 0, count: 0 });
  assert.equal(b.stage, 'onset');
});

test('measurements landing out of range are named, not silently lost', () => {
  const b = syncBlocker({ ...healthy, onsetTried: 3, onsetFailed: 0, accepted: 0, clamped: 3, count: 0 });
  assert.equal(b.stage, 'samples');
  assert.match(b.detail, /out of range/);
});

test('precedence: the most fundamental broken stage wins', () => {
  // Everything downstream is also broken; capture must still be the answer.
  const b = syncBlocker({
    ...healthy,
    capture: 'error',
    captureError: 'nope',
    peakLevel: 0,
    clock: 'none',
    loop: 'no-mic',
    candidates: 0,
    count: 0,
  });
  assert.equal(b.stage, 'capture', 'fix the root, not the symptom');
});

test('updates notify the listener and merge', () => {
  let seen = null;
  onSyncDiag((d) => {
    seen = d;
  });
  updateSyncDiag({ capture: 'open', captureLabel: 'X' });
  assert.equal(seen.capture, 'open');
  updateSyncDiag({ peakLevel: 0.5 });
  assert.equal(seen.captureLabel, 'X', 'earlier fields are preserved');
  assert.equal(seen.peakLevel, 0.5);
});

test('a throwing listener cannot break the pipeline', () => {
  onSyncDiag(() => {
    throw new Error('render bug');
  });
  assert.doesNotThrow(() => updateSyncDiag({ capture: 'open' }));
  assert.equal(syncDiag().capture, 'open');
});
