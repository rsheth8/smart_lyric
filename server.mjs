// Tiny zero-dependency static server for developing the renderer in a browser.
// `npm run dev` → http://localhost:4321  (Electron uses the same files directly.)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNeteaseLyrics } from './lib/netease.mjs';
import { fetchGeniusLyrics } from './lib/genius.mjs';
import { fetchMusixmatchRichsync } from './lib/musixmatch.mjs';
import { networkInterfaces } from 'node:os';
import { ROOM_RE, ROLES, MAX_MESSAGE_BYTES } from './app/companion.js';

const REPO = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(REPO, 'app');
// The renderer imports a few shared modules from the repo-root lib/ (e.g.
// providers/lyrics/transcript.js → ../../../lib/transcript-text.mjs). Electron
// resolves those on the filesystem, but they sit OUTSIDE the served app/ dir —
// unserved they 404, which fails the whole module graph up through app.js.
const LIB_ROOT = join(REPO, 'lib');
const PORT = process.env.PORT || 4321;

try {
  process.loadEnvFile(join(dirname(ROOT), '.env'));
} catch {
  /* no .env */
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function publicConfig() {
  return {
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    appleMusicDeveloperToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN || '',
    spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
  };
}

// ---- companion relay (phone ⇄ TV), LAN flavour ----
// In-memory rooms are fine for one machine on one Wi-Fi. The hosted twin with
// the same API is api/companion.js; the protocol lives in app/companion.js.
const rooms = new Map(); // room → { tv: Set<res>, phone: Set<res> }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

function lanOrigin() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${PORT}`;
    }
  }
  return null;
}

async function handleCompanion(req, res, q) {
  const room = q.get('room') || '';
  const role = q.get('role');
  if (!ROOM_RE.test(room) || !ROLES.includes(role)) {
    res.writeHead(400, CORS).end();
    return;
  }
  if (!rooms.has(room)) rooms.set(room, { tv: new Set(), phone: new Set() });
  const peers = rooms.get(room);

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_MESSAGE_BYTES) {
        res.writeHead(413, CORS).end();
        return;
      }
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, CORS).end();
      return;
    }
    // Re-serialised, so an untrusted body can't smuggle newlines into the SSE frame.
    const frame = `data: ${JSON.stringify(msg)}\n\n`;
    for (const peer of peers[role === 'tv' ? 'phone' : 'tv']) peer.write(frame);
    res.writeHead(204, CORS).end();
    return;
  }

  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.write(': open\n\n');
  peers[role].add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    peers[role].delete(res);
    if (!peers.tv.size && !peers.phone.size) rooms.delete(room);
  });
}

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    if (path === '/') path = '/index.html';

    if (path === '/api/companion/info') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lan: lanOrigin() }));
      return;
    }
    if (path === '/api/companion') {
      await handleCompanion(req, res, new URL(req.url, 'http://localhost').searchParams);
      return;
    }

    if (path === '/config.js') {
      const body = `window.__SL_CONFIG__ = ${JSON.stringify(publicConfig())};`;
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/api/lyrics') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const track = q.get('track') || '';
      const duration = Number(q.get('duration')) || undefined;
      let payload = { yrc: '', lrc: '', meta: null };
      if (track) {
        try {
          payload = (await fetchNeteaseLyrics({ artist: q.get('artist') || '', track, duration })) || payload;
        } catch { /* soft-fail → client falls through to LRCLIB */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (path === '/api/richsync') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const track = q.get('track') || '';
      let payload = { richsync: '', meta: null };
      if (track) {
        try {
          payload = (await fetchMusixmatchRichsync({ artist: q.get('artist') || '', track })) || payload;
        } catch { /* soft-fail → client falls through to line-level providers */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (path === '/api/genius') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const track = q.get('track') || '';
      let payload = { plain: '', meta: null };
      if (track) {
        try {
          payload = (await fetchGeniusLyrics({ artist: q.get('artist') || '', track })) || payload;
        } catch { /* soft-fail → no plain lyrics */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    const inLib = path === '/lib' || path.startsWith('/lib/');
    const base = inLib ? LIB_ROOT : ROOT;
    const file = normalize(join(base, inLib ? path.slice('/lib'.length) : path));
    if (!file.startsWith(base)) { res.writeHead(403).end('Forbidden'); return; }
    const body = await readFile(file);
    // Dev server: never cache assets, so edits show up on reload (stale cached
    // app.js/align.js was silently running old code after edits).
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
})
  .listen(PORT, () => console.log(`Bar4Bar dev server → http://localhost:${PORT}`))
  // Electron also starts this server; if `npm run dev` already holds the port,
  // log instead of crashing the main process — the running server serves both.
  .on('error', (e) => console.error(`[server] ${e.code === 'EADDRINUSE' ? `port ${PORT} already in use` : e.message}`));
