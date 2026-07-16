// ACRCloud recognition (Electron main process). Unlike AcoustID/Chromaprint,
// ACRCloud uses landmark fingerprinting built for *ambient* capture — a mic
// pointed at a speaker / turntable — so it survives room noise, reverb, vinyl
// EQ and pitch drift. Takes WAV bytes from the renderer, signs the request
// (HMAC-SHA1) and calls the Identify API.
//
// Docs: https://docs.acrcloud.com/reference/identification-api

const crypto = require('node:crypto');

function acrConfigured() {
  return !!(
    process.env.ACRCLOUD_HOST &&
    process.env.ACRCLOUD_ACCESS_KEY &&
    process.env.ACRCLOUD_ACCESS_SECRET
  );
}

async function identifyAcr(arrayBuffer) {
  const host = process.env.ACRCLOUD_HOST;
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;
  if (!host || !accessKey || !accessSecret) {
    throw new Error(
      'ACRCloud not configured — set ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET in .env'
    );
  }

  const endpoint = '/v1/identify';
  const dataType = 'audio';
  const signatureVersion = '1';
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const stringToSign = [
    'POST',
    endpoint,
    accessKey,
    dataType,
    signatureVersion,
    timestamp,
  ].join('\n');
  const signature = crypto
    .createHmac('sha1', accessSecret)
    .update(Buffer.from(stringToSign, 'utf-8'))
    .digest('base64');

  const sample = Buffer.from(arrayBuffer);
  const form = new FormData();
  form.append('sample', new Blob([sample]), 'sample.wav');
  form.append('sample_bytes', String(sample.length));
  form.append('access_key', accessKey);
  form.append('data_type', dataType);
  form.append('signature_version', signatureVersion);
  form.append('signature', signature);
  form.append('timestamp', timestamp);

  const res = await fetch(`https://${host}${endpoint}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ACRCloud lookup failed: HTTP ${res.status}`);
  const data = await res.json();

  const code = data?.status?.code;
  if (code === 1001) {
    console.log('[vinyl] ACRCloud → no result');
    return null; // no match for this sample
  }
  if (code !== 0) {
    throw new Error(`ACRCloud error ${code}: ${data?.status?.msg || 'unknown'}`);
  }

  const music = data?.metadata?.music?.[0];
  if (!music) return null;

  const artist = (music.artists || []).map((a) => a.name).filter(Boolean).join(', ') || null;
  // ACRCloud confidence is 0..100; normalize so it clears the detector's 0..1 gate.
  const score = music.score != null ? music.score / 100 : 1;
  const offsetSec = music.play_offset_ms != null ? music.play_offset_ms / 1000 : null;
  const duration = music.duration_ms != null ? music.duration_ms / 1000 : null;

  console.log(
    `[vinyl] ACRCloud → score ${music.score ?? '?'}, "${music.title}" — ${artist || '?'}` +
      (offsetSec != null ? `, offset ${offsetSec.toFixed(1)}s` : '')
  );

  return {
    recordingId: music.acrid || `${music.title}|${artist}`,
    title: music.title || null,
    artist,
    album: music.album?.name || null,
    duration,
    score,
    offsetSec,
    chunkDuration: null,
  };
}

module.exports = { identifyAcr, acrConfigured };
