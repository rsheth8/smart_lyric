import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWAV, decodeWAV, rms } from '../app/wav.js';

function readString(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

test('writes a valid RIFF/WAVE header', () => {
  const buf = encodeWAV(new Float32Array([0, 0]), 44100);
  const v = new DataView(buf);
  assert.equal(readString(v, 0, 4), 'RIFF');
  assert.equal(readString(v, 8, 4), 'WAVE');
  assert.equal(readString(v, 12, 4), 'fmt ');
  assert.equal(readString(v, 36, 4), 'data');
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 44100); // sample rate
  assert.equal(v.getUint16(34, true), 16); // bits per sample
});

test('buffer length is 44-byte header + 2 bytes per sample', () => {
  const buf = encodeWAV(new Float32Array(100), 44100);
  assert.equal(buf.byteLength, 44 + 100 * 2);
  const v = new DataView(buf);
  assert.equal(v.getUint32(40, true), 200); // data chunk size
});

test('converts full-scale samples to 16-bit correctly', () => {
  const buf = encodeWAV(new Float32Array([1, -1, 0]), 8000);
  const v = new DataView(buf);
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
  assert.equal(v.getInt16(48, true), 0);
});

test('clamps out-of-range samples', () => {
  const buf = encodeWAV(new Float32Array([2, -2]), 8000);
  const v = new DataView(buf);
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
});

test('rms is zero for silence and ~1 for full-scale', () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
  assert.equal(rms(new Float32Array([])), 0);
});

test('decodeWAV round-trips encodeWAV (mono 16-bit)', () => {
  const src = new Float32Array([0, 0.5, -0.5, 0.25, -0.9]);
  const { channels, sampleRate, numChannels } = decodeWAV(encodeWAV(src, 22050));
  assert.equal(sampleRate, 22050);
  assert.equal(numChannels, 1);
  for (let i = 0; i < src.length; i++) {
    // 16-bit quantization + encode(×0x7fff)/decode(÷0x8000) asymmetry ≈ 3e-5.
    assert.ok(Math.abs(channels[0][i] - src[i]) < 1e-4, `sample ${i}`);
  }
});

test('decodeWAV rejects non-WAV data', () => {
  assert.throws(() => decodeWAV(new ArrayBuffer(8)), /RIFF|WAVE/);
});
