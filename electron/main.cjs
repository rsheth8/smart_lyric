// Thin Electron shell: control window + optional projector overlay window.
//
// This file is CommonJS (.cjs) on purpose: Electron 31 + Node 20's ESM loader
// crashes preparsing the built-in `electron` module's exports when the main
// entry is ESM (cjsPreparseModuleExports → "Cannot read properties of
// undefined"). CJS main is the supported, reliable path. The two lyric helpers
// live in ESM (.mjs) modules and are loaded here via dynamic import().

const { app, BrowserWindow, Menu, ipcMain, screen, shell, session, desktopCapturer } = require('electron');
const { join } = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const http = require('node:http');
const { identifyWav } = require('./fingerprint.cjs');
const { identifyAcr, acrConfigured } = require('./acrcloud.cjs');
const { alignSong, alignAvailable, alignModelLoaded, alignWarm } = require('./align.cjs');
const { separateVocals, separateAvailable, separateWarm } = require('./separate.cjs');
const { transcribeAudio, transcribeAvailable } = require('./transcribe.cjs');
const { cleanLyricLines, guessSongLanguage, anthropicConfigured } = require('./anthropic.cjs');
const { buildMenu } = require('./menu.cjs');
const { restoreState, trackState } = require('./window-state.cjs');

// ESM-only helpers — pulled in lazily since this module is CommonJS.
const fetchNeteaseLyrics = (...args) =>
  import('../lib/netease.mjs').then((m) => m.fetchNeteaseLyrics(...args));
const fetchGeniusLyrics = (...args) =>
  import('../lib/genius.mjs').then((m) => m.fetchGeniusLyrics(...args));
const fetchMusixmatchRichsync = (...args) =>
  import('../lib/musixmatch.mjs').then((m) => m.fetchMusixmatchRichsync(...args));

app.setName('Bar4Bar');

try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch {
  /* no .env */
}

let mainWindow = null;
let projectorWindow = null;
let _alignErrorLogged = false;
let _separateErrorLogged = false;

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
    acrCloud: acrConfigured(),
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
  // Let the renderer's getDisplayMedia({ audio: true }) capture SYSTEM audio
  // (loopback) without a picker dialog — the internal tap for vocal alignment:
  // Spotify's output reaches the aligner digitally, with zero room noise.
  // Loopback audio is OS-dependent (Windows: native; macOS: needs OS support /
  // virtual device) — the renderer soft-falls back to a mic/loopback input.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback({ video: sources[0], audio: 'loopback' });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  const saved = restoreState(app);

  mainWindow = new BrowserWindow({
    title: 'Bar4Bar',
    icon: join(__dirname, '..', 'app', 'icon.svg'),
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 760,
    minHeight: 520,
    // Espresso, matching --surface-0. This was #070c16 — navy left over from the
    // pre-"Dark Luxury" palette — so every launch flashed blue before the app
    // painted over it.
    backgroundColor: '#0b0908',
    // The renderer draws its own titlebar strip and reserves room for the
    // traffic lights (body.is-electron in app/styles/shell.css).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    fullscreenable: true,
    show: false, // avoid a white/!themed frame before the first paint
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (saved.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  trackState(app, mainWindow);

  // Native menu items are routed to the renderer, which handles them with the
  // same code paths as the on-screen controls.
  Menu.setApplicationMenu(
    buildMenu({
      send: (action) => mainWindow?.webContents.send('menu', action),
    })
  );

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
      console.error('[vinyl] identify error:', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('identify-ambient', async (_e, arrayBuffer) => {
    try {
      return await identifyAcr(arrayBuffer);
    } catch (err) {
      console.error('[vinyl] ACRCloud identify error:', err.message);
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
  ipcMain.handle('genius-lyrics', async (_e, query) => {
    // Genius needs the secret token + a page scrape → main process only.
    try {
      return (await fetchGeniusLyrics(query || {})) || { plain: '', meta: null };
    } catch {
      return { plain: '', meta: null };
    }
  });
  ipcMain.handle('transcribe-audio', async (_e, payload) => transcribeAudio(payload || {}));
  ipcMain.handle('transcribe-available', () => transcribeAvailable());
  ipcMain.handle('clean-lyrics', async (_e, payload) => {
    try {
      return await cleanLyricLines(payload || {});
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });
  ipcMain.handle('clean-lyrics-available', () => anthropicConfigured());
  ipcMain.handle('guess-language', async (_e, payload) => {
    try {
      return await guessSongLanguage(payload || {});
    } catch (e) {
      return { language: null, error: e.message || String(e) };
    }
  });
  ipcMain.handle('align-song', async (_e, payload) => {
    // Forced alignment (CTC) — refine per-word vocal timing. Soft-fails so lyrics
    // timing is never disturbed when the model can't download (HF gateway, etc.).
    const result = await alignSong(payload || {});
    if (result?.error && !_alignErrorLogged) {
      console.warn('[align] vocal alignment unavailable:', result.error);
      _alignErrorLogged = true;
    }
    return result;
  });
  ipcMain.handle('align-available', () => alignAvailable());
  ipcMain.handle('align-model-loaded', () => alignModelLoaded());
  ipcMain.handle('align-warm', async () => {
    try {
      return await alignWarm();
    } catch {
      return false;
    }
  });

  ipcMain.handle('separate-vocals', async (_e, payload) => {
    // Vocal isolation before alignment. Soft-fails to null so a missing/failed
    // model just means we align the raw mix (never breaks lyrics timing).
    try {
      return await separateVocals(payload || {});
    } catch (err) {
      if (!_separateErrorLogged) {
        console.warn('[separate] vocal separation unavailable:', err?.message || err);
        _separateErrorLogged = true;
      }
      return null;
    }
  });
  ipcMain.handle('separate-available', () => separateAvailable());
  ipcMain.handle('separate-warm', async () => {
    try {
      return await separateWarm();
    } catch {
      return false;
    }
  });
  ipcMain.handle('richsync', async (_e, query) => {
    // Musixmatch richsync uses a reverse-engineered token endpoint (no CORS, and
    // it captcha-blocks datacenter IPs) → best from the residential-IP main process.
    try {
      return (await fetchMusixmatchRichsync(query || {})) || { richsync: '', meta: null };
    } catch {
      return { richsync: '', meta: null };
    }
  });
}

app.setAboutPanelOptions({
  applicationName: 'Bar4Bar',
  applicationVersion: app.getVersion(),
  copyright: 'Word-by-word lyrics that follow every bar, in sync.',
});

app.whenReady().then(() => {
  // The phone remote (app/companion.js) can't open file://, so the main process
  // also serves the app + companion relay on this machine's Wi-Fi.
  import('../server.mjs').catch((e) => console.error('[companion] LAN server failed:', e.message));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
