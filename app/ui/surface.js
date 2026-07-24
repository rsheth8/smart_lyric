// Density switch: the same renderer serves a laptop at arm's length and a
// projector/TV across the room. Everything density-dependent (type scale,
// spacing, hit targets, focus ring, safe-area inset) hangs off one attribute:
//
//   <body data-surface="desktop">  base 15px, 36px rows
//   <body data-surface="tv">       base 24px, 64px rows, 4px focus ring, 5% inset
//
// Electron can't run on tvOS, so this is not a tvOS target — it's what keeps the
// renderer portable, and what makes AirPlay/HDMI to a TV look right *today*.
//
// WHY THERE IS NO SIZE HEURISTIC
// ------------------------------
// This used to pick "tv" from viewport width (≥1600) or fullscreen. Both were
// wrong, for the same reason: a viewport cannot tell you how far away the viewer
// is sitting. A maximized 16" MacBook Pro is 1728pt and a 4K TV mirrored from a
// Mac usually reports 1920pt — the laptop looks "bigger" than the television. So
// every width threshold either fires on a laptop or misses a real TV.
//
// Fullscreen was no better: on macOS the green button IS fullscreen, so simply
// making the window full size silently doubled every dimension in the app.
//
// The surface is therefore DECLARED, not detected:
//   - the projector/overlay window hardcodes data-surface="tv" (overlay.html) —
//     that window is by definition the one on the far screen;
//   - anyone else picks it in Settings ▸ Display.
// "auto" means desktop. It stays as a mode so the setting has a neutral default
// and so a future host that genuinely knows its surface (a real tvOS shell) can
// answer for itself.

const STORE_KEY = 'bar4bar.surface';
export const MODES = ['auto', 'desktop', 'tv'];

/**
 * Resolve the effective surface. Pure — no DOM, no storage.
 *
 * @param {{ mode?: string }} env
 * @returns {'desktop'|'tv'}
 */
export function resolveSurface({ mode = 'auto' } = {}) {
  return mode === 'tv' ? 'tv' : 'desktop';
}

export function loadSurfaceMode() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return MODES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveSurfaceMode(mode) {
  try {
    if (MODES.includes(mode)) localStorage.setItem(STORE_KEY, mode);
  } catch {
    /* private mode — the session still works, it just won't persist */
  }
}

/**
 * Reflect the chosen surface onto `document.body[data-surface]`.
 * No resize or fullscreen listeners: the surface is a declared preference, not a
 * function of window geometry, so resizing the window must never change it.
 * @param {{ onChange?: (surface: string, mode: string) => void }} [opts]
 */
export function initSurface({ onChange = () => {} } = {}) {
  let mode = loadSurfaceMode();
  let last = null;

  function apply({ notify = true } = {}) {
    const surface = resolveSurface({ mode });
    if (surface === last) return surface;
    last = surface;
    document.body.dataset.surface = surface;
    if (notify) onChange(surface, mode);
    return surface;
  }

  // The first application is not a *change*, and firing onChange here would run
  // the caller's callback before it holds the handle this function returns.
  apply({ notify: false });

  return {
    get mode() {
      return mode;
    },
    get surface() {
      return last;
    },
    setMode(next) {
      if (!MODES.includes(next)) return;
      mode = next;
      saveSurfaceMode(next);
      apply();
    },
    refresh: () => apply(),
  };
}
