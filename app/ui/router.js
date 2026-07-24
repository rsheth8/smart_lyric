// Screen router for the tvOS-style hub.
//
// The stage carries two INDEPENDENT state axes:
//   data-mode   = setup | playing   ("is a song on screen") — pre-existing
//   data-screen = home | search | library | sources | settings  — this module
// data-screen only matters while data-mode is "setup"; the lyric view is not a
// screen, it's the other axis. Keeping them separate is why none of the working
// lyric CSS had to change.
//
// pushScreen/popScreen are pure so the history model is unit-testable without a DOM.

/** Screens that exist. `home` is the root and can never be popped off. */
export const SCREENS = ['home', 'search', 'library', 'sources', 'settings'];

/**
 * Push `name` onto a history stack. Pure.
 * Navigating to a screen already in the stack REWINDS to it rather than growing
 * the stack — otherwise home → settings → home → settings needs four backs to
 * escape, which feels broken on a remote.
 * @param {string[]} stack
 * @param {string} name
 * @returns {string[]}
 */
export function pushScreen(stack, name) {
  const list = Array.isArray(stack) && stack.length ? stack : ['home'];
  if (!SCREENS.includes(name)) return list;
  if (list[list.length - 1] === name) return list;
  const at = list.indexOf(name);
  if (at >= 0) return list.slice(0, at + 1);
  return [...list, name];
}

/**
 * Pop one level. Pure. Never empties — `home` is the floor.
 * @param {string[]} stack
 * @returns {string[]}
 */
export function popScreen(stack) {
  const list = Array.isArray(stack) && stack.length ? stack : ['home'];
  return list.length > 1 ? list.slice(0, -1) : list;
}

/**
 * Wire a router over `stage`.
 *
 * @param {{
 *   stage: HTMLElement,
 *   onEnter?: (name: string, prev: string|null) => void,
 *   onLeave?: (name: string) => void,
 * }} config
 */
export function createRouter({ stage, onEnter = () => {}, onLeave = () => {} }) {
  let stack = ['home'];
  // Where focus was when we left each screen, so going back lands you where you
  // were instead of dumping you at the top of the list — the single biggest
  // difference between "app" and "web page" when driving with a remote.
  const focusMemory = new Map();

  const current = () => stack[stack.length - 1];

  function apply(prev, { direction }) {
    const name = current();
    if (name === prev) return;

    if (prev) {
      const active = document.activeElement;
      if (active && active !== document.body && stage.contains(active)) {
        focusMemory.set(prev, active);
      }
      onLeave(prev);
    }

    stage.dataset.screen = name;
    stage.dataset.nav = direction; // drives the push/pop transition direction
    onEnter(name, prev);

    // Restore focus after the screen is visible, or the element has no layout
    // box yet and .focus() silently no-ops.
    requestAnimationFrame(() => {
      const remembered = focusMemory.get(name);
      if (remembered?.isConnected && remembered.offsetParent !== null) {
        remembered.focus({ preventScroll: true });
        return;
      }
      const host = stage.querySelector(`[data-screen-panel="${name}"]`);
      const first = host?.querySelector('[data-autofocus]')
        || host?.querySelector('button, input, select, [tabindex="0"]');
      first?.focus({ preventScroll: true });
    });
  }

  return {
    get current() {
      return current();
    },
    get stack() {
      return [...stack];
    },
    /** Navigate to a screen (rewinding if it's already in the stack). */
    go(name) {
      const prev = current();
      const next = pushScreen(stack, name);
      const direction = next.length < stack.length ? 'pop' : 'push';
      stack = next;
      apply(prev, { direction });
      return current();
    },
    /** Go up one level. Returns true if it moved. */
    back() {
      if (stack.length <= 1) return false;
      const prev = current();
      stack = popScreen(stack);
      apply(prev, { direction: 'pop' });
      return true;
    },
    /** Jump straight to the root without animating through intermediate screens. */
    home() {
      if (current() === 'home') return false;
      const prev = current();
      stack = ['home'];
      apply(prev, { direction: 'pop' });
      return true;
    },
    /** Forget a screen's remembered focus (e.g. after its list re-renders). */
    forgetFocus(name) {
      focusMemory.delete(name);
    },
  };
}
