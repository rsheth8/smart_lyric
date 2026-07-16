// Read basic ID3v2 / Vorbis tags from a local audio file (browser Blob).
// Lightweight parser — no bundler required.

function readSyncSafe(data, offset) {
  return ((data[offset] & 0x7f) << 21) | ((data[offset + 1] & 0x7f) << 14) | ((data[offset + 2] & 0x7f) << 7) | (data[offset + 3] & 0x7f);
}

function decodeText(data, encoding) {
  if (encoding === 0 || encoding === 3) {
    let end = 0;
    while (end < data.length && data[end] !== 0) end++;
    return new TextDecoder(encoding === 3 ? 'utf-8' : 'latin1').decode(data.subarray(0, end));
  }
  if (encoding === 1 || encoding === 2) {
    if (data.length < 2) return '';
    const bom = (data[0] << 8) | data[1];
    const start = bom === 0xfeff || bom === 0xfffe ? 2 : 0;
    const dec = new TextDecoder(encoding === 2 ? 'utf-16be' : 'utf-16le');
    return dec.decode(data.subarray(start)).replace(/\0.*$/, '');
  }
  return new TextDecoder('utf-8').decode(data).replace(/\0.*$/, '');
}

function parseId3v2(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 10) return {};
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2)) !== 'ID3') return {};

  const tags = {};
  const size = readSyncSafe(new Uint8Array(buffer), 6);
  let offset = 10;
  const end = Math.min(view.byteLength, 10 + size);

  while (offset + 10 <= end) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const frameSize = view.getUint32(offset + 4);
    offset += 10;
    if (frameSize <= 0 || offset + frameSize > end) break;

    const frame = new Uint8Array(buffer, offset, frameSize);
    offset += frameSize;

    if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
      const encoding = frame[0];
      const text = decodeText(frame.subarray(1), encoding);
      if (id === 'TIT2') tags.track = text;
      if (id === 'TPE1') tags.artist = text;
      if (id === 'TALB') tags.album = text;
    }
  }
  return tags;
}

function parseVorbisComment(buffer) {
  const tags = {};
  const bytes = new Uint8Array(buffer);
  const marker = [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // vorbis
  for (let i = 0; i < bytes.length - 64; i++) {
    if (bytes[i] === marker[0] && bytes.subarray(i, i + 6).every((b, j) => b === marker[j])) {
      let off = i + 7;
      if (off + 4 > bytes.length) break;
      const vendorLen = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
      off += 4 + vendorLen;
      if (off + 4 > bytes.length) break;
      const count = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
      off += 4;
      for (let c = 0; c < count && off + 4 <= bytes.length; c++) {
        const len = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
        off += 4;
        const str = new TextDecoder('utf-8').decode(bytes.subarray(off, off + len));
        off += len;
        const eq = str.indexOf('=');
        if (eq === -1) continue;
        const key = str.slice(0, eq).toUpperCase();
        const val = str.slice(eq + 1);
        if (key === 'TITLE') tags.track = val;
        if (key === 'ARTIST') tags.artist = val;
        if (key === 'ALBUM') tags.album = val;
      }
      break;
    }
  }
  return tags;
}

export async function readAudioTags(file) {
  if (!file) return null;
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const id3 = parseId3v2(head);
    const vorbis = parseVorbisComment(head);
    const artist = id3.artist || vorbis.artist || '';
    const track = id3.track || vorbis.track || '';
    const album = id3.album || vorbis.album || '';

    let duration;
    if (typeof document !== 'undefined') {
      duration = await new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const a = document.createElement('audio');
        a.preload = 'metadata';
        a.src = url;
        a.addEventListener('loadedmetadata', () => {
          resolve(a.duration && Number.isFinite(a.duration) ? Math.round(a.duration) : undefined);
          URL.revokeObjectURL(url);
        });
        a.addEventListener('error', () => {
          URL.revokeObjectURL(url);
          resolve(undefined);
        });
      });
    }

    if (!artist && !track && !duration) return null;
    return { artist, track, album, duration };
  } catch {
    return null;
  }
}
