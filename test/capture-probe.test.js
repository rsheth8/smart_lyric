import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeSignal, startBestCapture } from '../app/capture.js';

const noSleep = async () => {};

// ---- probeSignal ----------------------------------------------------------

test('probeSignal reports silence for a device carrying nothing', async () => {
  const res = await probeSignal({ level: 0 }, { ms: 200, sleep: noSleep });
  assert.equal(res.heard, false);
  assert.equal(res.peakLevel, 0);
});

test('probeSignal hears a live signal and returns early', async () => {
  const res = await probeSignal({ level: 0.2 }, { ms: 5000, sleep: noSleep });
  assert.equal(res.heard, true);
  assert.ok(res.peakLevel >= 0.2);
});

test('probeSignal tracks the peak of a fluctuating signal', async () => {
  let n = 0;
  const mic = { get level() { return [0, 0, 0.004, 0.05][n++] ?? 0; } };
  const res = await probeSignal(mic, { ms: 500, sleep: noSleep });
  assert.equal(res.heard, true, 'a later burst still counts');
});

test('probeSignal is safe with no mic', async () => {
  assert.deepEqual(await probeSignal(null, { sleep: noSleep }), { heard: false, peakLevel: 0 });
});

// ---- the ladder -----------------------------------------------------------
// Reproduces the reported bug: BlackHole installed (so it matches by name and
// opens fine) while macOS output is the laptop speakers, so it carries pure
// silence. Auto-timing then never measures anything and the chip reads
// "listening" forever. The ladder must notice and fall through to the real mic.

const DEVICES = [
  { deviceId: 'bh', label: 'BlackHole 2ch', kind: 'audioinput' },
  { deviceId: 'built-in', label: 'MacBook Pro Microphone', kind: 'audioinput' },
];

// `navigator` is a read-only getter on modern Node, so define it explicitly.
function installMedia() {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        enumerateDevices: async () => DEVICES,
        getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{}] }),
      },
    },
    configurable: true,
    writable: true,
  });
}

/** Make Mic.start() a no-op that reports the level this device is carrying. */
async function stubMicLevels(t, levels) {
  const { Mic } = await import('../app/mic.js');
  const orig = Mic.prototype.start;
  Mic.prototype.start = async function () {
    this.level = levels[this.deviceId] ?? 0;
  };
  t.after(() => {
    Mic.prototype.start = orig;
  });
}

beforeEach(installMedia);
afterEach(() => {
  delete globalThis.navigator;
});

test('a silent loopback is rejected and the real mic is used instead', async (t) => {
  // BlackHole is installed (matches by name, opens fine) but macOS output is the
  // laptop speakers, so it carries silence. This is the reported bug.
  await stubMicLevels(t, { bh: 0, 'built-in': 0.12 });
  const res = await startBestCapture({ mode: 'auto', probeMs: 150, sleep: noSleep });
  assert.ok(res?.mic, `expected a capture, got ${JSON.stringify(res)}`);
  assert.equal(res.kind, 'mic', 'must NOT settle on the silent loopback');
  assert.match(res.label, /MacBook/, 'fell through to the built-in mic');
  assert.equal(res.heard, true, 'and it is actually hearing audio');
  assert.match(res.fellBackFrom || '', /BlackHole/, 'reports what it abandoned');
});

test('a loopback that IS carrying audio is preferred (cleanest tap)', async (t) => {
  await stubMicLevels(t, { bh: 0.3, 'built-in': 0.12 });
  const res = await startBestCapture({ mode: 'auto', probeMs: 150, sleep: noSleep });
  assert.equal(res.kind, 'loopback', 'a live loopback wins');
  assert.ok(!res.fellBackFrom, 'nothing was abandoned');
});

test('mode "off" still returns null', async () => {
  assert.equal(await startBestCapture({ mode: 'off', sleep: noSleep }), null);
});

// ---- prefer-tap preference ------------------------------------------------

test('preferTap:false skips the loopback entirely and uses the mic', async (t) => {
  // A live BlackHole would normally win; with the preference off the mic is used
  // instead, because only a mic hears real speaker delay.
  await stubMicLevels(t, { bh: 0.3, 'built-in': 0.12 });
  const res = await startBestCapture({
    mode: 'auto',
    probeMs: 150,
    sleep: noSleep,
    preferTap: false,
  });
  assert.equal(res.kind, 'mic');
  assert.match(res.tapAvailable || '', /BlackHole/, 'still reports the tap exists');
});

test('a silent tap is reported as available so the UI can offer setup help', async (t) => {
  await stubMicLevels(t, { bh: 0, 'built-in': 0.12 });
  const res = await startBestCapture({ mode: 'auto', probeMs: 150, sleep: noSleep });
  assert.equal(res.kind, 'mic');
  assert.match(res.tapAvailable || '', /BlackHole/);
});

test('a working tap reports no outstanding setup', async (t) => {
  await stubMicLevels(t, { bh: 0.3, 'built-in': 0.12 });
  const res = await startBestCapture({ mode: 'auto', probeMs: 150, sleep: noSleep });
  assert.equal(res.kind, 'loopback');
  assert.ok(!res.tapAvailable, 'nothing to set up — we are on it');
});
