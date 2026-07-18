import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLoopbackDevice,
  findPreferredMicDevice,
  isLoopbackLabel,
  isJunkInputLabel,
  CAPTURE_MODES,
} from '../app/capture.js';

test('CAPTURE_MODES includes auto/system/device/off', () => {
  assert.deepEqual(
    CAPTURE_MODES.map((m) => m.id),
    ['auto', 'system', 'device', 'off']
  );
});

test('isLoopbackLabel accepts real cables, not Microsoft Virtual Mic', () => {
  assert.equal(isLoopbackLabel('BlackHole 2ch'), true);
  assert.equal(isLoopbackLabel('Loopback Audio'), true);
  assert.equal(isLoopbackLabel('Soundflower (2ch)'), true);
  assert.equal(isLoopbackLabel('VB-Audio Virtual Cable'), true);
  assert.equal(isLoopbackLabel('Stereo Mix'), true);
  assert.equal(isLoopbackLabel('Microsoft Virtual Mic'), false);
  assert.equal(isLoopbackLabel('Virtual Mic'), false);
  assert.equal(isLoopbackLabel('MacBook Pro Microphone'), false);
});

test('isJunkInputLabel flags softphone / fake mics', () => {
  assert.equal(isJunkInputLabel('Microsoft Virtual Mic'), true);
  assert.equal(isJunkInputLabel('Zoom Audio Device'), true);
  assert.equal(isJunkInputLabel('MacBook Pro Microphone'), false);
  assert.equal(isJunkInputLabel('BlackHole 2ch'), false);
});

test('findLoopbackDevice skips junk virtual mics', () => {
  const devices = [
    { deviceId: '1', label: 'Microsoft Virtual Mic' },
    { deviceId: '2', label: 'MacBook Pro Microphone' },
    { deviceId: '3', label: 'BlackHole 2ch' },
  ];
  assert.equal(findLoopbackDevice(devices)?.deviceId, '3');
  assert.equal(findLoopbackDevice([{ deviceId: '1', label: 'Microsoft Virtual Mic' }]), null);
});

test('findPreferredMicDevice prefers built-in over Microsoft Virtual Mic', () => {
  const devices = [
    { deviceId: 'default', label: 'Default - Microsoft Virtual Mic' },
    { deviceId: 'junk', label: 'Microsoft Virtual Mic' },
    { deviceId: 'real', label: 'MacBook Pro Microphone' },
  ];
  assert.equal(findPreferredMicDevice(devices)?.deviceId, 'real');
});

test('findPreferredMicDevice returns null when only junk is listed', () => {
  assert.equal(
    findPreferredMicDevice([{ deviceId: 'j', label: 'Microsoft Virtual Mic' }]),
    null
  );
});
