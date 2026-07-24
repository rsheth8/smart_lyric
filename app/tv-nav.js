// D-pad / arrow-key spatial navigation for the 10-foot ("couch") UI.
//
// tvOS-style: arrow keys move DOM focus geometrically between the setup
// screen's controls; Enter activates via native button behavior. This is the
// groundwork for driving the app from a TV remote (projector/Apple TV via
// AirPlay today, a native tvOS focus engine later): the same "nearest control
// in that direction" model tvOS uses, so the layout stays portable.
//
// pickNext() is pure geometry over rects so it's unit-testable without a DOM.

const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * Choose the next rect when moving `dir` from rects[fromIdx].
 * Candidates must lie strictly in the travel direction (by center). Score is
 * distance along the travel axis plus a cross-axis penalty — mild when the
 * candidate's edges overlap the current control's span (same row/column feel),
 * heavy otherwise, so focus doesn't skip diagonally when an aligned control exists.
 * @param {Array<{left:number,top:number,right:number,bottom:number,width:number,height:number}>} rects
 * @param {number} fromIdx
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {number} index of the best candidate, or -1 (edge of the screen)
 */
export function pickNext(rects, fromIdx, dir) {
  const from = rects[fromIdx];
  if (!from) return -1;
  const fcx = from.left + from.width / 2;
  const fcy = from.top + from.height / 2;

  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === fromIdx) continue;
    const r = rects[i];
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - fcx;
    const dy = cy - fcy;

    let primary;
    let ortho;
    let overlaps;
    if (dir === 'left' || dir === 'right') {
      if (dir === 'left' ? dx >= -1 : dx <= 1) continue;
      primary = Math.abs(dx);
      ortho = Math.abs(dy);
      overlaps = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) > 0;
    } else {
      if (dir === 'up' ? dy >= -1 : dy <= 1) continue;
      primary = Math.abs(dy);
      ortho = Math.abs(dx);
      overlaps = Math.min(from.right, r.right) - Math.max(from.left, r.left) > 0;
    }

    const score = primary + ortho * (overlaps ? 0.3 : 3);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Wire arrow-key navigation over the focusable controls inside `root`.
 * `root` may be an element or a function returning one — the hub resolves it per
 * keystroke so navigation is scoped to whichever screen is currently showing.
 * `isActive(e)` gates each keystroke (mode checks, letting inputs keep their
 * caret / suggestion-list keys). Returns a disposer.
 */
export function initTvNav({ root, isActive = () => true }) {
  const resolveRoot = () => (typeof root === 'function' ? root() : root);
  const focusables = () => {
    const host = resolveRoot();
    if (!host) return [];
    return [...host.querySelectorAll('button, input, select, [tabindex="0"]')].filter(
      (el) => !el.disabled && el.offsetParent !== null && !el.hidden
    );
  };

  const onKey = (e) => {
    const dir = DIRS[e.key];
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!isActive(e)) return;
    const els = focusables();
    if (!els.length) return;

    const idx = els.indexOf(document.activeElement);
    if (idx < 0) {
      // Nothing (or something outside the root) focused — land on the first control.
      e.preventDefault();
      els[0].focus();
      return;
    }
    const next = pickNext(els.map((el) => el.getBoundingClientRect()), idx, dir);
    if (next >= 0) {
      e.preventDefault();
      els[next].focus();
      // Keep the focused card visible inside its shelf and the scrolling panel.
      els[next].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  };

  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}
