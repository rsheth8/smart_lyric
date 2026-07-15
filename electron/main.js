// Thin Electron shell: a borderless, fullscreen-capable window that loads the
// same renderer as the dev server. This is what runs on the projector machine.

import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { identifyWav } = require('./fingerprint.cjs');

// Load ACOUSTID_API_KEY (and any other secrets) from the project-root .env,
// so the user doesn't have to `export` anything before `npm start`.
try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch {
  /* no .env — fall back to whatever is already in the shell environment */
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#05060a',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, '..', 'app', 'index.html'));

  ipcMain.handle('toggle-fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });

  // Fingerprint a WAV chunk from the renderer and return the AcoustID match.
  ipcMain.handle('identify', async (_e, arrayBuffer) => {
    try {
      return await identifyWav(arrayBuffer);
    } catch (err) {
      return { error: err.message };
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
