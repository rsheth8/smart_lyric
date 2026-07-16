// Fingerprint service (Electron main process). Takes WAV bytes from the renderer,
// runs Chromaprint's `fpcalc`, queries AcoustID, aligns fingerprint for offset.

const { execFile } = require('node:child_process');
const { writeFile, unlink } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Each Chromaprint integer ≈ 1.024s of audio at default settings.
const SECONDS_PER_FP = 1.024;

function fpcalc(file) {
  return new Promise((resolve, reject) => {
    execFile('fpcalc', ['-json', file], (err, stdout) => {
      if (err) return reject(new Error('fpcalc failed (is chromaprint installed?): ' + err.message));
      try {
        const j = JSON.parse(stdout);
        resolve({ fingerprint: j.fingerprint, duration: j.duration });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseFingerprint(fp) {
  return fp.split(',').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
}

function alignFingerprints(query, reference) {
  if (!query.length || !reference.length) return 0;
  let bestIdx = 0;
  let bestScore = -1;
  const qLen = query.length;
  for (let i = 0; i <= reference.length - qLen; i++) {
    let score = 0;
    for (let j = 0; j < qLen; j++) {
      const diff = Math.abs(query[j] - reference[i + j]);
      score += 32 - Math.min(diff, 32);
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx * SECONDS_PER_FP;
}

async function fetchReferenceFingerprint(recordingId, apiKey) {
  const params = new URLSearchParams({
    client: apiKey,
    meta: 'recordings',
    recordingid: recordingId,
  });
  const res = await fetch(`https://api.acoustid.org/v2/metadata?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  const rec = data.recordings?.[0];
  const src = rec?.sources?.find((s) => s.fingerprint?.fingerprint);
  return src?.fingerprint?.fingerprint || null;
}

async function identifyWav(arrayBuffer) {
  const key = process.env.ACOUSTID_API_KEY;
  if (!key) throw new Error('ACOUSTID_API_KEY is not set — get a free key at acoustid.org/new-application');

  const tmp = path.join(os.tmpdir(), `bar4bar-${crypto.randomUUID()}.wav`);
  await writeFile(tmp, Buffer.from(arrayBuffer));
  try {
    const { fingerprint, duration } = await fpcalc(tmp);
    const params = new URLSearchParams({
      client: key,
      duration: String(Math.round(duration)),
      fingerprint,
      meta: 'recordings+releasegroups+compress',
    });
    const res = await fetch(`https://api.acoustid.org/v2/lookup?${params}`);
    if (!res.ok) throw new Error(`AcoustID lookup failed: HTTP ${res.status}`);
    const data = await res.json();

    const results = data.results || [];
    const top = results.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const rec = top && top.recordings && top.recordings[0];
    console.log(
      `[vinyl] fp ${Math.round(duration)}s → ${results.length} result(s)` +
        (top ? `, top score ${(top.score ?? 0).toFixed(2)}` : '') +
        (rec ? `, "${rec.title}" — ${rec.artists?.[0]?.name || '?'}` : ', no recording metadata')
    );
    if (!rec) return null;

    let offsetSec = null;
    try {
      const refFp = await fetchReferenceFingerprint(rec.id, key);
      if (refFp) {
        offsetSec = alignFingerprints(parseFingerprint(fingerprint), parseFingerprint(refFp));
      }
    } catch {
      /* offset is best-effort */
    }

    return {
      recordingId: rec.id,
      title: rec.title || null,
      artist: rec.artists && rec.artists[0] ? rec.artists[0].name : null,
      album: rec.releasegroups && rec.releasegroups[0] ? rec.releasegroups[0].title : null,
      duration: rec.duration || duration,
      score: top.score != null ? top.score : null,
      offsetSec,
      chunkDuration: duration,
    };
  } finally {
    unlink(tmp).catch(() => {});
  }
}

module.exports = { identifyWav, alignFingerprints, parseFingerprint, SECONDS_PER_FP };
