// Screen-scoped D-pad focus.
//
// Before the hub existed, arrow-key nav was one global listener bound to the
// single #setup panel (app.js). With five screens stacked in the DOM at once,
// that would let focus walk into hidden screens. This scopes navigation to
// whichever surface is actually on screen: the active screen panel in setup
// mode, the now-playing chrome in playing mode.
//
// The geometry itself is untouched — pickNext() in tv-nav.js is pure and
// unit-tested, and this only decides which rects to hand it.

import { initTvNav } from '../tv-nav.js';

/**
 * @param {{
 *   stage: HTMLElement,
 *   router: { current: string },
 *   isTyping?: (e: KeyboardEvent) => boolean,
 * }} config
 * @returns {() => void} disposer
 */
export function initScreenFocus({ stage, router, isTyping = () => false }) {
  const activeRoot = () => {
    if (stage.dataset.mode === 'playing') {
      // While a song is up, arrows belong to the chrome only when it's awake —
      // otherwise a keypress moves focus onto an invisible bar.
      const nowbar = stage.querySelector('#nowbar:not(.hide)');
      const inspector = stage.querySelector('#inspector:not([hidden])');
      return inspector || nowbar || null;
    }
    return stage.querySelector(`[data-screen-panel="${router.current}"]`);
  };

  return initTvNav({
    root: activeRoot,
    isActive: (e) => {
      if (isTyping(e)) return false;
      // Left/right inside a text field move the caret; up/down don't, so those
      // still navigate out of the search box.
      const el = document.activeElement;
      if (el?.tagName === 'INPUT' && el.type !== 'checkbox' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        return false;
      }
      if (el?.tagName === 'SELECT') return false; // native listbox owns arrows
      return true;
    },
  });
}
