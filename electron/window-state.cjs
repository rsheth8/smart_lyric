// Remember where the window was.
//
// An app that reopens at 1280×800 in the middle of the screen every single time,
// no matter how you left it, is a browser window pretending to be an app. This
// persists bounds + maximized state to userData and validates them on restore,
// so unplugging the external display you last used doesn't strand the window
// off-screen.

const { screen } = require('electron');
const { join } = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');

const FILE = 'window-state.json';
const DEFAULTS = { width: 1280, height: 800 };

function statePath(app) {
  return join(app.getPath('userData'), FILE);
}

/** True when the rect is at least partly on some currently-connected display. */
function isVisibleSomewhere(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });
}

/**
 * Read saved bounds, falling back to defaults when missing, corrupt, or pointing
 * at a display that's no longer attached.
 * @param {Electron.App} app
 */
function restoreState(app) {
  try {
    const saved = JSON.parse(readFileSync(statePath(app), 'utf8'));
    const bounds = {
      width: Math.max(760, saved.width || DEFAULTS.width),
      height: Math.max(520, saved.height || DEFAULTS.height),
      x: saved.x,
      y: saved.y,
    };
    if (!isVisibleSomewhere(bounds)) {
      // Keep the remembered SIZE, drop the off-screen position and let the OS
      // centre it — resizing to fit is more useful than starting from scratch.
      delete bounds.x;
      delete bounds.y;
    }
    return { ...bounds, maximized: !!saved.maximized };
  } catch {
    return { ...DEFAULTS, maximized: false };
  }
}

/**
 * Persist the window's geometry as it changes. Returns a disposer.
 * @param {Electron.App} app
 * @param {Electron.BrowserWindow} win
 */
function trackState(app, win) {
  let timer = null;

  const save = () => {
    try {
      // getNormalBounds is the pre-maximize/pre-fullscreen rect, which is what
      // we want to restore to — saving the maximized rect would make un-
      // maximizing a no-op on the next launch.
      const bounds = win.getNormalBounds();
      writeFileSync(
        statePath(app),
        JSON.stringify({ ...bounds, maximized: win.isMaximized() })
      );
    } catch {
      /* a lost window position is never worth an error dialog */
    }
  };

  // Debounced: resize/move fire continuously while dragging.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', save);

  return () => {
    clearTimeout(timer);
    win.off('resize', schedule);
    win.off('move', schedule);
    win.off('maximize', schedule);
    win.off('unmaximize', schedule);
    win.off('close', save);
  };
}

module.exports = { restoreState, trackState, isVisibleSomewhere };
