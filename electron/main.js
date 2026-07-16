// Thin Electron shell: control window + optional projector overlay window.

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fetchNeteaseLyrics } from '../lib/netease.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { identifyWav } = require('./fingerprint.cjs');

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

/** Prefer deployed HTTPS URL (Vercel) when set. */
function spotifyRedirectUri() {
  const configured = (process.env.SPOTIFY_REDIRECT_URI || '').trim();
  if (configured) return configured.endsWith('/') ? configured : `${configured}/`;
  return 'http://127.0.0.1:18923/callback';
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

  const redirectUri = spotifyRedirectUri();
  const redirectPrefix = redirectUri.split('?')[0].replace(/\/?$/, '');
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
    const authWindow = new BrowserWindow({
      width: 520,
      height: 740,
      show: true,
      alwaysOnTop: true,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (!authWindow.isDestroyed()) authWindow.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const isCallback = (url) => {
      if (!url || typeof url !== 'string') return false;
      // Match https://…vercel.app/ or …/callback with optional query/hash
      return url === redirectUri || url.startsWith(redirectUri) || url.startsWith(redirectPrefix + '/?') || url.startsWith(redirectPrefix + '?');
    };

    const handleCallbackUrl = (url) => {
      try {
        const u = new URL(url);
        if (u.searchParams.get('error')) {
          finish({ error: u.searchParams.get('error_description') || u.searchParams.get('error') });
          return;
        }
        const code = u.searchParams.get('code');
        const returnedState = u.searchParams.get('state');
        if (!code) {
          finish({ error: 'No authorization code returned from Spotify.' });
          return;
        }
        if (returnedState !== state) {
          finish({ error: 'OAuth state mismatch — try Connect Spotify again.' });
          return;
        }
        exchangeSpotifyCode({ code, verifier, redirectUri })
          .then((token) => finish(token))
          .catch((err) => finish({ error: err.message || String(err) }));
      } catch (err) {
        finish({ error: err.message || String(err) });
      }
    };

    // preventDefault MUST be synchronous — async .then is too late and the popup
    // navigates to Vercel without returning a token to the main window.
    const onNav = (event, url) => {
      if (!isCallback(url)) return;
      event.preventDefault();
      handleCallbackUrl(url);
    };

    authWindow.webContents.on('will-redirect', onNav);
    authWindow.webContents.on('will-navigate', onNav);
    authWindow.webContents.on('did-navigate', (_e, url) => {
      if (isCallback(url) && !settled) handleCallbackUrl(url);
    });
    authWindow.on('closed', () => {
      if (!settled) finish({ error: 'Login window closed before finishing.' });
    });

    authWindow.loadURL(authUrl).catch((err) => finish({ error: err.message }));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
