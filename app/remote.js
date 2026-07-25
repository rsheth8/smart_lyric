// Siri Remote / TV-remote intent layer.
//
// Every input the app understood before this file was a raw keyboard event —
// arrows for focus, Space for play/pause, Escape for back, a pile of letter
// hotkeys. A Siri Remote produces none of those the same way: swipe is
// directional, the centre is a click, and Play/Pause and the track buttons are
// dedicated *hardware* keys that arrive either as `Media*` key codes or, more
// reliably in a web runtime, through the Media Session API — never as Space.
//
// This module is the single normaliser. It turns whichever of those the
// environment emits into a small vocabulary of INTENTS, so feature code
// subscribes to "play/pause" instead of guessing at `e.code === 'Space'`.
//
// Division of labour (mirrors tvOS itself, where the focus engine and remote
// button presses are separate systems): directional focus — MOVE / SELECT — is
// still owned by the focus engine (tv-nav.js), which arrows already drive. What
// remote.js uniquely adds is the transport/system layer the focus engine never
// covered: the physical Play/Pause, track, and Menu buttons. classify() still
// recognises the directional keys and returns MOVE intents so the model is
// complete and testable (and ready for a native focus-engine bridge), but the
// app is free to ignore them and let the focus engine own navigation.
//
// classify() is pure over an event-like `{key, code, metaKey, ctrlKey, altKey}`
// so it unit-tests without a DOM, the same way pickNext() does.

export const Intent = {
  MOVE: 'move', // dir: 'up' | 'down' | 'left' | 'right'
  SELECT: 'select', // centre click / Enter
  PLAYPAUSE: 'playpause', // dedicated toggle button (one press = one toggle)
  NEXT: 'next',
  PREV: 'prev',
  BACK: 'back', // Menu button / Escape — peel one layer
  MENU: 'menu', // long-press Menu / contextual (reserved)
  VOICE: 'voice', // Siri button (reserved — filled once a voice slot exists)
};

const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * Map a keyboard event-like object to a remote intent, or null if it isn't one.
 * Pure: reads only `key`, `code`, and the modifier flags.
 *
 * Modifier chords (⌘/Ctrl/Alt) are left alone — those are app/OS accelerators
 * (⌘, for settings, ⌘F fullscreen), not remote buttons.
 *
 * @param {{key?:string, code?:string, metaKey?:boolean, ctrlKey?:boolean, altKey?:boolean}} ev
 * @returns {{type:string, dir?:string, source:string} | null}
 */
export function classify(ev) {
  if (!ev) return null;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  const key = ev.key;
  const code = ev.code;

  // Hardware transport keys (Siri Remote, media keyboards). Always win over any
  // text meaning — a physical Play button is never a character.
  switch (key) {
    case 'MediaPlayPause':
    case 'MediaPlay':
    case 'MediaPause':
      return { type: Intent.PLAYPAUSE, source: 'media' };
    case 'MediaTrackNext':
      return { type: Intent.NEXT, source: 'media' };
    case 'MediaTrackPrevious':
      return { type: Intent.PREV, source: 'media' };
    case 'MediaStop':
      return { type: Intent.BACK, source: 'media' };
  }

  const dir = ARROWS[key];
  if (dir) return { type: Intent.MOVE, dir, source: 'key' };
  if (key === 'Enter') return { type: Intent.SELECT, source: 'key' };
  if (key === 'Escape' || key === 'GoBack' || key === 'BrowserBack') {
    return { type: Intent.BACK, source: 'key' };
  }
  // Space is play/pause only outside a text field — the caller's guard enforces
  // that (classify stays pure and context-free).
  if (code === 'Space' || key === ' ' || key === 'Spacebar') {
    return { type: Intent.PLAYPAUSE, source: 'key' };
  }
  return null;
}

/**
 * Wire the environment's inputs to `onIntent`. Listens to keydown and, when
 * available, registers Media Session action handlers so a hardware Play/Pause or
 * track button drives the same intents even on platforms that route those
 * through the OS rather than as key events.
 *
 * `guard(intent, ev)` may veto an intent (e.g. Space-as-play/pause while typing).
 * It receives a null `ev` for Media Session-originated intents, which carry no
 * DOM event and should generally never be vetoed.
 *
 * @param {{ onIntent:(intent:object, ev:(KeyboardEvent|null))=>void, guard?:(intent:object, ev:(KeyboardEvent|null))=>boolean }} config
 * @returns {() => void} disposer
 */
export function initRemote({ onIntent, guard = () => true }) {
  const emit = (intent, ev) => {
    if (!intent) return;
    if (!guard(intent, ev)) return;
    onIntent(intent, ev || null);
  };

  const onKey = (ev) => emit(classify(ev), ev);
  addEventListener('keydown', onKey);

  // Media Session: the robust path for hardware transport buttons in a web
  // runtime. Both play and pause map to the same toggle intent so the Siri
  // Remote's single Play/Pause button toggles regardless of what playback state
  // the OS believes we're in.
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  const wired = [];
  if (ms && typeof ms.setActionHandler === 'function') {
    const set = (action, type) => {
      try {
        ms.setActionHandler(action, () => emit({ type, source: 'mediaSession' }, null));
        wired.push(action);
      } catch {
        /* action unsupported on this platform — skip it */
      }
    };
    set('play', Intent.PLAYPAUSE);
    set('pause', Intent.PLAYPAUSE);
    set('nexttrack', Intent.NEXT);
    set('previoustrack', Intent.PREV);
  }

  return () => {
    removeEventListener('keydown', onKey);
    if (ms) for (const a of wired) { try { ms.setActionHandler(a, null); } catch { /* noop */ } }
  };
}
