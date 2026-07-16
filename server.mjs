// Tiny zero-dependency static server for developing the renderer in a browser.
// `npm run dev` → http://localhost:4321  (Electron uses the same files directly.)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNeteaseLyrics } from './lib/netease.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'app');
const PORT = process.env.PORT || 4321;

try {
  process.loadEnvFile(join(dirname(ROOT), '.env'));
} catch {
  /* no .env */
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
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

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    if (path === '/') path = '/index.html';

    if (path === '/config.js') {
      const body = `window.__SL_CONFIG__ = ${JSON.stringify(publicConfig())};`;
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/api/lyrics') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const track = q.get('track') || '';
      let payload = { yrc: '', lrc: '', meta: null };
      if (track) {
        try {
          payload = (await fetchNeteaseLyrics({ artist: q.get('artist') || '', track })) || payload;
        } catch { /* soft-fail → client falls through to LRCLIB */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`smart_lyric dev server → http://localhost:${PORT}`));
