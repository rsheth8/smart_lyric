// Audio capture source selection for vocal alignment ("follow" audio).
//
// Preference order for a CLEAN signal (no room noise), when "Prefer a digital
// tap" is on:
//   1. System-audio loopback via getDisplayMedia — Electron's internal tap.
//      Hears the mix digitally so speaker / headphone volume stays independent.
//   2. A known virtual loopback INPUT (BlackHole, Rogue Amoeba Loopback,
//      Soundflower, Stereo Mix, VB-Cable) — when it's actually carrying audio.
//   3. A real microphone (Built-in / MacBook / USB) — never "Microsoft Virtual Mic"
//      or other softphone fakes that match the word "virtual".
//
// All sources are wrapped in the same Mic ring buffer, so the aligner and the
// vinyl fingerprint path don't care where samples came from.

import { Mic } from './mic.js';

/**
 * Real system-audio loopback / cable devices only.
 * Deliberately does NOT match bare "virtual" — that catches Microsoft Virtual Mic,
 * Zoom/Teams soft mics, etc. which are silent for Spotify playback.
 */
const LOOPBACK_NAME_RE =
  /\bblackhole\b|\bsoundflower\b|\bstereo\s*mix\b|\bvb-?(audio|cable)\b|\bishowu\b|\bcable\s*(input|output)\b|(^|[^a-z])loopback([^a-z]|$)/i;

/** Softphone / fake mics Auto must never prefer. */
const JUNK_INPUT_RE =
  /microsoft\s*virtual|virtual\s*mic|zoom|teams|discord|skype|webex|cisco|obs\s*virtual|mmhmm|snap\s*camera|droidcam|iriun|epoccam|nvidia\s*broadcast/i;

/** Labels that look like a physical / built-in microphone. */
const REAL_MIC_RE =
  /\bmicrophone\b|\bmic\b|\bmacbook\b|\bbuilt-?in\b|\binternal\b|\busb\b|\bheadset\b|\bearpods\b|\bairpods\b|\biphone\b|\bexternal\b|\bline\s*in\b|\baggregate\b/i;

/** How long Auto waits on getDisplayMedia before giving up (ms). */
const SYSTEM_TAP_TIMEOUT_MS = 2500;

export const CAPTURE_MODES = [
  { id: 'auto', label: 'Auto (internal tap first)' },
  { id: 'system', label: 'System audio (internal tap)' },
  { id: 'device', label: 'Input device…' },
  { id: 'off', label: 'Off — line sync only' },
];

/** True when a label is a known digital loopback cable (not a softphone mic). */
export function isLoopbackLabel(label) {
  const s = String(label || '');
  if (!s || JUNK_INPUT_RE.test(s)) return false;
  return LOOPBACK_NAME_RE.test(s);
}

/** Softphone / fake inputs Auto should skip. */
export function isJunkInputLabel(label) {
  return JUNK_INPUT_RE.test(String(label || ''));
}

/** All audio input devices (labels appear after any getUserMedia grant). */
export async function listInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

/** Find a real virtual loopback input (BlackHole etc.) among the devices. */
export function findLoopbackDevice(devices) {
  return (devices || []).find((d) => isLoopbackLabel(d.label)) || null;
}

/**
 * Prefer a physical / built-in mic over junk virtual defaults.
 * Returns null to mean "browser/OS default" when nothing better is labeled yet
 * (labels are empty before the first mic permission grant).
 */
export function findPreferredMicDevice(devices) {
  const list = devices || [];
  const usable = list.filter((d) => d.deviceId && d.deviceId !== 'default' && !isJunkInputLabel(d.label));
  if (!usable.length) return null;

  const real = usable.find((d) => REAL_MIC_RE.test(d.label || '') && !isLoopbackLabel(d.label));
  if (real) return real;

  // Any non-junk, non-loopback labeled device beats an empty default that may be
  // Microsoft Virtual Mic at the OS level.
  const other = usable.find((d) => (d.label || '').trim() && !isLoopbackLabel(d.label));
  return other || null;
}

function withTimeout(promise, ms, label = 'timed out') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Try the digital system-audio tap (getDisplayMedia loopback).
 * @returns {Promise<{ mic: import('./mic.js').Mic }|{ error: string }>}
 */
export async function startSystemAudioCapture({ seconds = 16, timeoutMs = SYSTEM_TAP_TIMEOUT_MS } = {}) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return { error: 'System audio tap not available in this build' };
  }
  let stream;
  try {
    // Video track is mandatory for getDisplayMedia; we stop it immediately.
    stream = await withTimeout(
      navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { frameRate: 1, width: 2, height: 2 },
      }),
      timeoutMs,
      'System audio tap timed out (grant Screen Recording, or use a mic / BlackHole)'
    );
  } catch (err) {
    return { error: err?.message || 'System audio tap failed' };
  }
  for (const track of stream.getVideoTracks()) track.stop();
  if (!stream.getAudioTracks().length) {
    for (const track of stream.getTracks()) track.stop();
    return {
      error:
        'System tap returned no audio (common on macOS) — use BlackHole or the microphone',
    };
  }
  const mic = new Mic({ seconds, stream });
  try {
    await mic.start();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    return { error: err?.message || 'Could not open system-audio stream' };
  }
  mic.sourceKind = 'system';
  return { mic };
}

/** Open a specific input device (or the default mic). */
export async function startDeviceCapture({ deviceId = null, seconds = 16 } = {}) {
  const mic = new Mic({ seconds, deviceId });
  try {
    await mic.start();
  } catch (err) {
    const denied = /Permission|NotAllowed|denied/i.test(err?.name || err?.message || '');
    return {
      error: denied
        ? 'Microphone permission denied — allow it in System Settings → Privacy'
        : err?.message || 'Could not open audio input',
    };
  }
  mic.sourceKind = deviceId ? 'device' : 'mic';
  return { mic };
}

/**
 * Listen briefly and report whether a capture is actually carrying audio.
 *
 * A virtual loopback device (BlackHole, VB-Cable) opens perfectly happily while
 * routed to nothing at all — it just yields digital silence forever. Picking one
 * by name and trusting it is how auto-timing ends up stuck "listening": every
 * onset check fails the amplitude gate and no measurement is ever produced. So
 * a candidate has to prove it hears something before we commit to it.
 *
 * Reads the Mic's existing smoothed RMS (`mic.level`) — no extra audio graph.
 *
 * @param {{ level?: number }} mic
 * @param {{ ms?: number, minLevel?: number, sleep?: (ms:number)=>Promise<void> }} [opts]
 * @returns {Promise<{ heard: boolean, peakLevel: number }>}
 */
export async function probeSignal(mic, { ms = 900, minLevel = 0.01, sleep = defaultSleep } = {}) {
  if (!mic) return { heard: false, peakLevel: 0 };
  const step = 50;
  let peak = 0;
  for (let waited = 0; waited < ms; waited += step) {
    const level = Number(mic.level) || 0;
    if (level > peak) peak = level;
    if (peak >= minLevel) return { heard: true, peakLevel: peak }; // early out
    await sleep(step);
  }
  return { heard: peak >= minLevel, peakLevel: peak };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Close a capture we've decided not to use. */
function discard(mic) {
  try {
    mic?.stop();
  } catch {
    /* ignore */
  }
}

/**
 * Start the best capture for `mode`.
 * @returns {Promise<{ mic: import('./mic.js').Mic, kind: string, label: string,
 *   heard?: boolean, peakLevel?: number, fellBackFrom?: string }|{ error: string }|null>}
 *   null only for mode === 'off'
 */
export async function startBestCapture({
  mode = 'auto',
  deviceId = null,
  seconds = 16,
  probeMs = 900,
  sleep = defaultSleep,
  preferTap = true,
} = {}) {
  if (mode === 'off') return null;

  if (mode === 'system') {
    const sys = await startSystemAudioCapture({ seconds });
    if (sys.mic) {
      const probe = await probeSignal(sys.mic, { ms: probeMs, sleep });
      return { mic: sys.mic, kind: 'system', label: 'System audio', ...probe };
    }
    return { error: sys.error || 'System audio unavailable' };
  }

  if (mode === 'device') {
    const res = await startDeviceCapture({ deviceId, seconds });
    if (res.mic) {
      const devices = await listInputDevices();
      const match = devices.find((d) => d.deviceId === deviceId);
      return { mic: res.mic, kind: 'device', label: match?.label || 'Selected input' };
    }
    return { error: res.error || 'Could not open selected input' };
  }

  // auto: internal system tap → virtual loopback device → real mic.
  // The internal tap hears the mix digitally, so normal speaker / headphone
  // volume stays independent — no Multi-Output Device, no mic-in-the-room.
  let devices = await listInputDevices();

  // First mic open unlocks device labels; if everything is unlabeled, open the
  // default briefly so enumerateDevices returns names, then pick properly.
  if (devices.length && devices.every((d) => !(d.label || '').trim())) {
    const probe = await startDeviceCapture({ deviceId: null, seconds });
    if (probe.mic) {
      try {
        probe.mic.stop();
      } catch {
        /* ignore */
      }
      devices = await listInputDevices();
    }
  }

  let fellBackFrom = null;
  let tapAvailable = null; // a cable tap exists but isn't carrying audio → setup help
  let systemHold = null; // opened but still silent — prefer over mic if nothing else hears

  if (preferTap) {
    const sys = await startSystemAudioCapture({ seconds });
    if (sys.mic) {
      const probe = await probeSignal(sys.mic, { ms: probeMs, sleep });
      if (probe.heard) {
        return { mic: sys.mic, kind: 'system', label: 'System audio', ...probe };
      }
      // Tap opened but is quiet (track may not have started). Hold it — a silent
      // mic is worse, and we'll commit to this if no live cable tap appears.
      systemHold = { mic: sys.mic, kind: 'system', label: 'System audio', ...probe };
    }
  }

  // A named loopback cable is the cleanest tap when it's actually carrying the
  // audio, but it opens just as happily when output is routed elsewhere — in
  // which case it yields silence forever. Make it prove it hears something.
  const loop = preferTap ? findLoopbackDevice(devices) : null;
  if (!preferTap) tapAvailable = findLoopbackDevice(devices)?.label || null;
  if (loop) {
    const res = await startDeviceCapture({ deviceId: loop.deviceId, seconds });
    if (res.mic) {
      const probe = await probeSignal(res.mic, { ms: probeMs, sleep });
      if (probe.heard) {
        if (systemHold) discard(systemHold.mic);
        return { mic: res.mic, kind: 'loopback', label: loop.label || 'Loopback input', ...probe };
      }
      discard(res.mic);
      fellBackFrom = loop.label || 'Loopback input';
      tapAvailable = loop.label || 'Loopback input';
    }
  }

  // Internal tap beat the mic even when still silent — speaker volume shouldn't
  // gate whether sync can listen.
  if (systemHold) return { ...systemHold, fellBackFrom, tapAvailable };

  const preferred = findPreferredMicDevice(devices);
  const micId = preferred?.deviceId || deviceId || null;
  // Never pass a junk device id even if it was saved as the OS default elsewhere.
  const safeId =
    micId && devices.some((d) => d.deviceId === micId && isJunkInputLabel(d.label)) ? null : micId;
  const pick = preferred || (safeId ? devices.find((d) => d.deviceId === safeId) : null);
  const micRes = await startDeviceCapture({
    deviceId: preferred?.deviceId || safeId,
    seconds,
  });
  if (micRes.mic) {
    const label = pick?.label || preferred?.label || 'Microphone';
    // If we somehow still opened junk, reject and try unlabeled default once.
    if (isJunkInputLabel(label)) {
      discard(micRes.mic);
    } else {
      // A real mic hearing nothing is usually a quiet room, not a dead route, so
      // we keep it either way — but report the level so the UI can say so.
      const probe = await probeSignal(micRes.mic, { ms: probeMs, sleep });
      return { mic: micRes.mic, kind: 'mic', label, ...probe, fellBackFrom, tapAvailable };
    }
  }

  // Last resort: any non-junk device.
  for (const d of devices) {
    if (!d.deviceId || isJunkInputLabel(d.label) || isLoopbackLabel(d.label)) continue;
    if (preferred && d.deviceId === preferred.deviceId) continue;
    const alt = await startDeviceCapture({ deviceId: d.deviceId, seconds });
    if (alt.mic) {
      const probe = await probeSignal(alt.mic, { ms: probeMs, sleep });
      return { mic: alt.mic, kind: 'mic', label: d.label || 'Microphone', ...probe, fellBackFrom, tapAvailable };
    }
  }

  return {
    error:
      micRes.error ||
      'No usable mic found — pick System audio or a real microphone under Sync',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the mic has heard audio, then collect `targetSec` more seconds.
 * Used for Spotify AI-lyrics capture (need a long contiguous buffer, not a 16s ring).
 * @returns {Promise<{ ok: boolean, heardSec: number, reason?: string }>}
 */
export async function waitForCaptureWindow(
  mic,
  { targetSec = 60, timeoutSec = 120, onProgress } = {}
) {
  if (!mic) return { ok: false, heardSec: 0, reason: 'No capture' };
  const deadline = Date.now() + Math.max(timeoutSec, targetSec + 30) * 1000;

  while (mic.onsetAt == null && Date.now() < deadline) {
    onProgress?.(0, 'Waiting for Spotify audio…');
    await sleep(200);
  }
  if (mic.onsetAt == null) {
    return {
      ok: false,
      heardSec: 0,
      reason:
        'Heard no audio — play Spotify on speakers, or set Sync → Source to BlackHole / system audio',
    };
  }

  const start = performance.now();
  while ((performance.now() - start) / 1000 < targetSec && Date.now() < deadline) {
    const heard = (performance.now() - start) / 1000;
    onProgress?.(
      heard,
      `Listening for lyrics… ${Math.floor(heard)}s / ${Math.floor(targetSec)}s`
    );
    await sleep(250);
  }

  const heardSec = (performance.now() - start) / 1000;
  const samples = mic.filled ? mic.buffer.length : mic.writeIndex;
  const bufferedSec = samples / (mic.sampleRate || 44100);
  if (bufferedSec < 15 && heardSec < 15) {
    return {
      ok: false,
      heardSec,
      reason: 'Not enough audio captured to transcribe.',
    };
  }
  return { ok: true, heardSec: Math.max(heardSec, bufferedSec) };
}
