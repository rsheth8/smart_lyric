// ACRCloud ambient recognition, shared by the hosted relay (api/identify.js) and
// the LAN dev server (server.mjs).
//
// Landmark fingerprinting built for a mic pointed at a room, so it survives
// reverb, speaker EQ and a turntable running a percent fast — and, crucially, it
// returns `play_offset_ms`: how far into the song the sample was. That offset is
// what lets a TV with no playback control still put lyrics on the beat.
//
// The Apple TV app cannot hold these credentials: anything in an app bundle is
// readable. It posts WAV bytes here instead and this signs the request.
//
// Docs: https://docs.acrcloud.com/reference/identification-api

import crypto from 'node:crypto';

const ENDPOINT = '/v1/identify';
const DATA_TYPE = 'audio';
const SIGNATURE_VERSION = '1';

export function acrConfigured(env = process.env) {
  return !!(env.ACRCLOUD_HOST && env.ACRCLOUD_ACCESS_KEY && env.ACRCLOUD_ACCESS_SECRET);
}

/**
 * The signed form fields for one identify call. Split out from the request so a
 * test can check the signature without the network — ACRCloud rejects the whole
 * call on a single wrong byte here, and the error it returns doesn't say why.
 */
export function signedFields({ accessKey, accessSecret, timestamp }) {
  const stringToSign = ['POST', ENDPOINT, accessKey, DATA_TYPE, SIGNATURE_VERSION, timestamp].join('\n');
  const signature = crypto
    .createHmac('sha1', accessSecret)
    .update(Buffer.from(stringToSign, 'utf-8'))
    .digest('base64');
  return {
    access_key: accessKey,
    data_type: DATA_TYPE,
    signature_version: SIGNATURE_VERSION,
    signature,
    timestamp,
  };
}

/**
 * ACRCloud's response → the shape the clients consume, or null for "heard it,
 * matched nothing". Throws only on a real service error, which the caller turns
 * into a 502 — a miss is not an error.
 */
export function normalizeMatch(data) {
  const code = data?.status?.code;
  if (code === 1001) return null; // no match for this sample
  if (code !== 0) {
    throw new Error(`ACRCloud error ${code}: ${data?.status?.msg || 'unknown'}`);
  }

  const music = data?.metadata?.music?.[0];
  if (!music) return null;

  const artist = (music.artists || []).map((a) => a.name).filter(Boolean).join(', ') || '';
  return {
    recordingId: music.acrid || `${music.title}|${artist}`,
    title: music.title || '',
    artist,
    album: music.album?.name || null,
    // ACRCloud confidence is 0..100; the detector's gate is 0..1.
    score: music.score != null ? music.score / 100 : 1,
    durationSec: music.duration_ms != null ? music.duration_ms / 1000 : null,
    offsetSec: music.play_offset_ms != null ? music.play_offset_ms / 1000 : null,
  };
}

/**
 * Identify a WAV sample. Returns the normalized match, or null for no match.
 * @param {Buffer|Uint8Array} wav
 */
export async function identify(wav, env = process.env, fetchImpl = fetch) {
  if (!acrConfigured(env)) {
    throw new Error('ACRCloud not configured — set ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET');
  }
  const sample = Buffer.from(wav);
  const fields = signedFields({
    accessKey: env.ACRCLOUD_ACCESS_KEY,
    accessSecret: env.ACRCLOUD_ACCESS_SECRET,
    timestamp: Math.floor(Date.now() / 1000).toString(),
  });

  const form = new FormData();
  form.append('sample', new Blob([sample]), 'sample.wav');
  form.append('sample_bytes', String(sample.length));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const res = await fetchImpl(`https://${env.ACRCLOUD_HOST}${ENDPOINT}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ACRCloud lookup failed: HTTP ${res.status}`);
  return normalizeMatch(await res.json());
}
