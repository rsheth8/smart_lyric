// Encode mono Float32 PCM samples into a 16-bit WAV (ArrayBuffer).
// Pure and dependency-free so it runs in the renderer and is unit-testable.
// fpcalc (in the Electron main process) reads this to fingerprint the audio.

export function encodeWAV(samples, sampleRate = 44100) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function readString(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Decode a PCM/float WAV (ArrayBuffer) into planar Float32 channels. Handles
// 16/32-bit int and 32-bit float, mono or multi-channel, and skips unknown
// chunks (LIST/fact/etc.). Used by the separation validation script.
export function decodeWAV(buffer) {
  const view = new DataView(buffer);
  if (readString(view, 0, 4) !== 'RIFF' || readString(view, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = readString(view, off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        numChannels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, view.byteLength - body);
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error('missing fmt/data chunk');

  const { numChannels, bitsPerSample, audioFormat, sampleRate } = fmt;
  const bytesPer = bitsPerSample >> 3;
  const frames = Math.floor(dataSize / (bytesPer * numChannels));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  const isFloat = audioFormat === 3;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const p = dataOffset + (i * numChannels + c) * bytesPer;
      let s;
      if (isFloat && bitsPerSample === 32) s = view.getFloat32(p, true);
      else if (bitsPerSample === 16) s = view.getInt16(p, true) / 0x8000;
      else if (bitsPerSample === 32) s = view.getInt32(p, true) / 0x80000000;
      else if (bitsPerSample === 8) s = (view.getUint8(p) - 128) / 128;
      else s = 0;
      channels[c][i] = s;
    }
  }
  return { channels, sampleRate, numChannels };
}

// Root-mean-square level of a sample block — used for silence/onset detection.
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
