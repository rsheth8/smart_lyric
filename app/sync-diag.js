// Why isn't auto-sync locking?
//
// Every stage of the timing pipeline used to fail silently — a bare `return
// false` deep in the aligner, a swallowed catch, a device that opened but was
// carrying no audio. All of them surfaced identically as "Sync listening…", so
// there was no way to tell "the mic is muted" from "the lyrics have no words".
//
// This records the state of each stage and names the FIRST one that's blocking.
// Pure state + a single listener, mirroring the live-separation HUD in align.js.

/** Ordered most-fundamental first: if capture is dead, nothing downstream matters. */
const STAGES = ['capture', 'audio', 'clock', 'loop', 'window', 'onset', 'samples'];

/** Loop states that mean "nothing to do right now", not "something is wrong". */
const LOOP_IDLE_REASONS = new Set(['measuring', 'idle', 'no-candidate']);

const blank = () => ({
  capture: 'off', // off | starting | open | error
  captureKind: null, // loopback | mic | system
  captureLabel: '',
  captureError: '',
  fellBackFrom: null,
  peakLevel: 0, // rolling max mic level since the song started
  clock: 'ok', // ok | none
  loop: 'idle', // idle | measuring | auto-off | no-mic | no-clock | no-aligner | no-candidate | not-playing
  lastTickMs: 0,
  candidates: 0,
  onsetTried: 0,
  onsetFailed: 0,
  accepted: 0,
  clamped: 0,
  count: 0,
  confidence: 0,
  lock: 'listening',
});

let state = blank();
let listener = null;

export function onSyncDiag(fn) {
  listener = typeof fn === 'function' ? fn : null;
}

export function syncDiag() {
  return { ...state };
}

export function resetSyncDiag() {
  state = blank();
  emit();
}

/** Merge a partial update and notify. Never throws into the caller. */
export function updateSyncDiag(patch) {
  if (!patch) return;
  state = { ...state, ...patch };
  emit();
}

function emit() {
  try {
    listener?.({ ...state });
  } catch {
    /* a diagnostic must never break the thing it's diagnosing */
  }
}

/**
 * The first stage that's blocking a lock, or null when everything's healthy.
 * @returns {{stage: string, detail: string}|null}
 */
export function syncBlocker(d = state) {
  if (d.lock === 'locked') return null;
  if (d.capture === 'error') return { stage: 'capture', detail: d.captureError || 'capture failed' };
  if (d.capture === 'off') return { stage: 'capture', detail: 'not listening' };
  if (d.capture === 'starting') return { stage: 'capture', detail: 'opening input…' };
  if (d.peakLevel < 0.01) {
    return {
      stage: 'audio',
      detail: d.captureKind === 'loopback' ? 'digital tap is silent' : 'hearing nothing',
    };
  }
  if (d.clock === 'none') return { stage: 'clock', detail: 'no playback position' };
  // 'no-candidate' is NOT a fault: the loop ticks every 700ms but a line only
  // becomes measurable ~1.5s after it finishes, and is then excluded until it
  // goes stale. Most ticks legitimately have nothing new to measure, so this is
  // the normal waiting state — reporting it as a broken loop was just noise.
  if (!LOOP_IDLE_REASONS.has(d.loop)) return { stage: 'loop', detail: d.loop };
  if (d.candidates === 0) return { stage: 'window', detail: 'waiting for the next line' };
  if (d.onsetTried > 0 && d.accepted === 0 && d.onsetFailed === d.onsetTried) {
    return { stage: 'onset', detail: 'no vocal onset found' };
  }
  if (d.clamped > 0 && d.accepted === 0) {
    return { stage: 'samples', detail: 'measurements out of range' };
  }
  if (d.count === 0) return { stage: 'samples', detail: 'no measurements yet' };
  return { stage: 'samples', detail: `${d.count} samples, ${Math.round(d.confidence * 100)}% agree` };
}

/** One short human line for the HUD. */
export function syncDiagSummary(d = state) {
  if (d.lock === 'locked') return `◉ sync locked · ${d.count} samples`;
  const b = syncBlocker(d);
  if (!b) return '◉ sync locked';
  const src = d.captureLabel ? ` · ${d.captureLabel}` : '';
  return `◌ sync ${b.stage}: ${b.detail}${b.stage === 'capture' || b.stage === 'audio' ? src : ''}`;
}

/**
 * Copy for the digital-tap setup helper. Pure so the branching is testable.
 *
 * Only worth showing when a tap is installed but we're NOT using it — that's the
 * case where routing is the thing standing between the user and a clean signal.
 * @param {{tapAvailable:string|null, onTap:boolean, preferTap:boolean, captureLabel:string}} s
 */
export function tapHelpCopy({ tapAvailable, onTap, preferTap, captureLabel } = {}) {
  if (!tapAvailable || onTap) return { show: false, title: '', lead: '' };
  if (!preferTap) {
    return {
      show: true,
      title: `${tapAvailable} is available`,
      lead: 'Turn on “Prefer a digital tap” above to use it. Route output to both so you can still hear the music:',
    };
  }
  return {
    show: true,
    title: `${tapAvailable} is installed but silent`,
    lead: `Audio isn't routed to it, so it hears nothing — we're listening on ${captureLabel || 'the microphone'} instead. Send output to BOTH so you can still hear the music:`,
  };
}

export { STAGES };
