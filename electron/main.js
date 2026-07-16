// Thin Electron shell: control window + optional projector overlay window.

import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { fetchNeteaseLyrics } from '../lib/netease.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { identifyWav } = require('./fingerprint.cjs');

app.setName('Bar4Bar');

try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch {
  /* no .env */
}

let mainWindow = null;
let projectorWindow = null;

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-recently-played',
].join(' ');

function loadEnvConfig() {
  return {
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    appleMusicDeveloperToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN || '',
    spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
  };
}

// The desktop app authenticates through the SYSTEM browser with a loopback
// redirect (OAuth 2.0 for Native Apps, RFC 8252). This avoids Spotify's endless
// "are you human" challenges — Spotify (like Google) actively blocks OAuth inside
// embedded webviews. This exact URI must be added to the Spotify Dashboard's
// Redirect URIs list: http://127.0.0.1:18923/callback
const ELECTRON_REDIRECT_PORT = 18923;
// Trailing slash must match the Spotify Dashboard entry exactly
// (http://127.0.0.1:18923/callback/).
const ELECTRON_REDIRECT_URI = `http://127.0.0.1:${ELECTRON_REDIRECT_PORT}/callback/`;

// Minimal HTML shown in the user's browser tab after the OAuth redirect lands.
function callbackPage(title, detail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#05060a;color:#f7f5ef;font-family:-apple-system,system-ui,sans-serif}
.card{text-align:center;padding:40px 48px;border-radius:16px;background:rgba(255,255,255,.04);
box-shadow:0 20px 60px rgba(0,0,0,.5)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:rgba(247,245,239,.6)}
b{color:#e0b062}</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p></div>
<script>setTimeout(()=>window.close(),1500)</script></body></html>`;
}

function injectConfig(win) {
  const config = loadEnvConfig();
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__SL_CONFIG__ = ${JSON.stringify(config)};`);
  });
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function exchangeSpotifyCode({ code, verifier, redirectUri }) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

function spotifyLogin() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return Promise.resolve({ error: 'SPOTIFY_CLIENT_ID is not set in .env' });
  }

  const redirectUri = ELECTRON_REDIRECT_URI;
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(16));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params}`;

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const server = http.createServer();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      // Accept /callback and /callback/ — Dashboard entry uses the trailing slash.
      if (u.pathname !== '/callback' && u.pathname !== '/callback/') {
        res.writeHead(204);
        res.end();
        return;
      }

      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');

      const respond = (title, detail) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage(title, detail));
      };

      if (err) {
        respond('Login failed', 'You can close this tab and try again.');
        finish({ error: u.searchParams.get('error_description') || err });
        return;
      }
      if (!code) {
        respond('Login failed', 'No authorization code returned.');
        finish({ error: 'No authorization code returned from Spotify.' });
        return;
      }
      if (returnedState !== state) {
        respond('Login failed', 'Security check failed — please try again.');
        finish({ error: 'OAuth state mismatch — try Connect Spotify again.' });
        return;
      }

      exchangeSpotifyCode({ code, verifier, redirectUri })
        .then((token) => {
          respond('Connected to Spotify', 'You can close this tab and return to Bar4Bar.');
          mainWindow?.focus();
          finish(token);
        })
        .catch((exErr) => {
          respond('Login failed', 'Could not complete sign-in. Try again.');
          finish({ error: exErr.message || String(exErr) });
        });
    });

    server.on('error', (e) => {
      finish({
        error:
          e.code === 'EADDRINUSE'
            ? `Login port ${ELECTRON_REDIRECT_PORT} is busy. Close the other login attempt and try again.`
            : e.message || String(e),
      });
    });

    // Give up if the user never finishes in the browser.
    timeout = setTimeout(() => finish({ error: 'Spotify login timed out. Try Connect Spotify again.' }), 5 * 60 * 1000);

    server.listen(ELECTRON_REDIRECT_PORT, '127.0.0.1', () => {
      // Open in the user's real browser — Spotify blocks embedded webviews with
      // repeated "are you human" challenges, so this is what avoids the loop.
      shell.openExternal(authUrl).catch((e) => finish({ error: e.message || String(e) }));
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Bar4Bar',
    icon: join(__dirname, '..', 'app', 'icon.svg'),
    width: 1280,
    height: 800,
    backgroundColor: '#070c16',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  injectConfig(mainWindow);
  mainWindow.loadFile(join(__dirname, '..', 'app', 'index.html'));

  ipcMain.handle('toggle-fullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('identify', async (_e, arrayBuffer) => {
    try {
      return await identifyWav(arrayBuffer);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('get-displays', () =>
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label || `Display ${d.id}`,
      primary: d.internal || d.bounds.x === 0,
      bounds: d.bounds,
    }))
  );

  ipcMain.handle('open-projector', (_e, displayId) => {
    if (projectorWindow) {
      projectorWindow.focus();
      return true;
    }
    const displays = screen.getAllDisplays();
    const target = displayId ? displays.find((d) => d.id === displayId) : displays[1] || displays[0];

    projectorWindow = new BrowserWindow({
      title: 'Bar4Bar overlay',
      x: target?.bounds.x,
      y: target?.bounds.y,
      width: target?.bounds.width,
      height: target?.bounds.height,
      backgroundColor: '#00000000',
      transparent: true,
      frame: false,
      fullscreen: !!displayId,
      alwaysOnTop: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    injectConfig(projectorWindow);
    projectorWindow.loadFile(join(__dirname, '..', 'app', 'overlay.html'));
    projectorWindow.on('closed', () => {
      projectorWindow = null;
    });
    return true;
  });

  ipcMain.handle('close-projector', () => {
    projectorWindow?.close();
    projectorWindow = null;
    return true;
  });

  ipcMain.handle('get-config', () => loadEnvConfig());
  ipcMain.handle('spotify-login', () => spotifyLogin());
  ipcMain.handle('word-lyrics', async (_e, query) => {
    // Renderer loads via file:// with no proxy, so fetch NetEase here in main.
    try {
      return (await fetchNeteaseLyrics(query || {})) || { yrc: '', lrc: '', meta: null };
    } catch {
      return { yrc: '', lrc: '', meta: null };
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
