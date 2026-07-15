// Fingerprint service (Electron main process). Takes WAV bytes from the renderer,
// runs Chromaprint's `fpcalc`, queries AcoustID, and returns the best match.
// This is the Node counterpart of identify.py.

const { execFile } = require('node:child_process');
const { writeFile, unlink } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

// arrayBuffer: the WAV payload from the renderer. Returns match metadata or null.
async function identifyWav(arrayBuffer) {
  const key = process.env.ACOUSTID_API_KEY;
  if (!key) throw new Error('ACOUSTID_API_KEY is not set — get a free key at acoustid.org/new-application');

  const tmp = path.join(os.tmpdir(), `smartlyric-${crypto.randomUUID()}.wav`);
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

    const top = (data.results || []).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const rec = top && top.recordings && top.recordings[0];
    if (!rec) return null;

    return {
      recordingId: rec.id,
      title: rec.title || null,
      artist: rec.artists && rec.artists[0] ? rec.artists[0].name : null,
      album: rec.releasegroups && rec.releasegroups[0] ? rec.releasegroups[0].title : null,
      duration: rec.duration || duration,
      score: top.score != null ? top.score : null,
    };
  } finally {
    unlink(tmp).catch(() => {});
  }
}

module.exports = { identifyWav };
