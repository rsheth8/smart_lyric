// Pre-play timing calibration: find the first catalog vocal, listen for the
// real onset in capture, and convert that into a syncOffset sample.
//
// Formula matches live auto-timing in align.js:
//   value = catalogExpected − rawOnsetSongTime
// Positive ⇒ lyrics should lead the clock (hear-lag / catalog-early).

import { estimateOnset } from './align.js';

/** First sung moment in the timeline (word 0 of the first non-empty line). */
export function firstCatalogVocalSec(timeline) {
  const lines = timeline?.lines;
  if (!lines?.length) return null;
  for (const line of lines) {
    if (!(line.end > line.start)) continue;
    const w0 = line.words?.[0]?.start;
    if (Number.isFinite(w0)) return w0;
    if (Number.isFinite(line.start)) return line.start;
  }
  return null;
}

/**
 * Seek target for a short preroll: a few seconds before the first vocal so we
 * hear the attack, without scrubbing through half the intro.
 */
export function prerollSeekSec(expectedSec, { padSec = 2.5, minSec = 0 } = {}) {
  if (!Number.isFinite(expectedSec)) return null;
  return Math.max(minSec, expectedSec - padSec);
}

/** Latency sample from a capture-window onset (song-time base). */
export function latencyFromOnset({ expectedSec, windowStartSec, onsetTimeInWindow }) {
  if (
    !Number.isFinite(expectedSec) ||
    !Number.isFinite(windowStartSec) ||
    !Number.isFinite(onsetTimeInWindow)
  ) {
    return null;
  }
  const rawOnset = windowStartSec + onsetTimeInWindow;
  return expectedSec - rawOnset;
}

/**
 * Re-anchor deltas (line.start − originalStart) → one global latency sample.
 * If CTC moved lines later (+delta), the catalog was early ⇒ negative offset
 * value (show lyrics later), i.e. value ≈ −delta.
 */
export function timingSamplesFromReanchors(
  lines,
  { minAbs = 0.04, maxAbs = 1.5, weight = 1.8 } = {}
) {
  const deltas = [];
  for (const line of lines || []) {
    const d = line._reanchorDelta;
    if (!Number.isFinite(d)) continue;
    const a = Math.abs(d);
    if (a < minAbs || a > maxAbs) continue;
    deltas.push(d);
  }
  if (!deltas.length) return [];
  deltas.sort((a, b) => a - b);
  const mid = deltas[Math.floor(deltas.length / 2)];
  return [
    {
      value: -mid,
      score: 0.9,
      weight,
      source: 'reanchor',
    },
  ];
}

/**
 * Poll the mic ring for a clear onset near the catalog vocal. `getSongPos`
 * must return the current song position in seconds (streaming clock).
 *
 * @returns {Promise<{ offset: number, score: number, rawOnset: number }|null>}
 */
export async function waitForPrerollOnset({
  mic,
  expectedSec,
  getSongPos,
  timeoutSec = 8,
  searchPadSec = 2.2,
  pollMs = 120,
  estimate = estimateOnset,
} = {}) {
  if (!mic || !Number.isFinite(expectedSec) || typeof getSongPos !== 'function') return null;
  const deadline = Date.now() + timeoutSec * 1000;
  let best = null;

  while (Date.now() < deadline) {
    const songPos = Number(getSongPos()) || 0;
    // Don't bother until playback has entered the search window around the vocal.
    if (songPos + 0.15 < expectedSec - searchPadSec) {
      await sleep(pollMs);
      continue;
    }
    if (songPos > expectedSec + searchPadSec + 1.5) break;

    const pcm = mic.getOrderedPcm?.();
    const sr = mic.sampleRate || 44100;
    if (!pcm?.length || pcm.length < sr * 0.3) {
      await sleep(pollMs);
      continue;
    }

    // Treat the end of the ring as "now" in song time; walk back for the window.
    const bufferedSec = pcm.length / sr;
    const windowEnd = songPos;
    const windowStart = Math.max(0, windowEnd - bufferedSec);
    const searchFrom = Math.max(windowStart, expectedSec - searchPadSec);
    const searchTo = Math.min(windowEnd, expectedSec + searchPadSec);
    if (searchTo - searchFrom < 0.25) {
      await sleep(pollMs);
      continue;
    }

    const i0 = Math.max(0, Math.floor((searchFrom - windowStart) * sr));
    const i1 = Math.min(pcm.length, Math.ceil((searchTo - windowStart) * sr));
    if (i1 - i0 < sr * 0.2) {
      await sleep(pollMs);
      continue;
    }

    const onset = estimate(pcm.subarray(i0, i1), sr);
    if (onset) {
      const offset = latencyFromOnset({
        expectedSec,
        windowStartSec: searchFrom,
        onsetTimeInWindow: onset.time,
      });
      if (offset != null && Number.isFinite(offset) && Math.abs(offset) < 2.5) {
        const cand = {
          offset,
          score: onset.score,
          rawOnset: searchFrom + onset.time,
        };
        if (!best || cand.score > best.score) best = cand;
        // Confident enough — lock in without burning the full timeout.
        if (cand.score >= 0.75) return cand;
      }
    }
    await sleep(pollMs);
  }
  return best;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
