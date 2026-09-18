// Tiny zero-dependency static server for developing the renderer in a browser.
// `npm run dev` → http://localhost:4321  (Electron uses the same files directly.)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNeteaseLyrics } from './lib/netease.mjs';
import { fetchGeniusLyrics } from './lib/genius.mjs';
import { fetchMusixmatchRichsync } from './lib/musixmatch.mjs';
import tvPairHandler from './api/tv-pair.js';

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
    youtubeConfigured: !!(process.env.YOUTUBE_API_KEY || '').trim(),
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
      const isrc = q.get('isrc') || '';
      const spotifyID = q.get('spotifyID') || q.get('spotifyId') || '';
      const appleMusicID = q.get('appleMusicID') || q.get('appleMusicId') || '';
      let payload = { richsync: '', meta: null };
      if (track || isrc || spotifyID || appleMusicID) {
        try {
          payload = (await fetchMusixmatchRichsync({
            artist: q.get('artist') || '', track, isrc, spotifyID, appleMusicID,
            duration: q.get('duration'),
          })) || payload;
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

    // The Apple TV Spotify handshake. Shares the Vercel handler outright rather
    // than being reimplemented here — the two drifting apart would only ever be
    // discovered in production, on the one flow that has no way to retry.
    if (path === '/api/tv-pair' || path === '/tv') {
      if (path === '/tv') req.url = '/api/tv-pair?action=page';
      await tvPairHandler(req, res);
      return;
    }

    if (path === '/api/youtube') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
      const key = (process.env.YOUTUBE_API_KEY || '').trim();
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid id', configured: !!key }));
        return;
      }
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ id, embeddable: null, title: null, channelTitle: null, configured: false }));
        return;
      }
      try {
        const url =
          'https://www.googleapis.com/youtube/v3/videos' +
          `?part=status,snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
        const upstream = await fetch(url);
        if (!upstream.ok) {
          res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `YouTube API ${upstream.status}`, configured: true }));
          return;
        }
        const data = await upstream.json();
        const item = data?.items?.[0];
        const payload = item
          ? {
              id,
              embeddable: item.status?.embeddable !== false,
              title: item.snippet?.title || null,
              channelTitle: item.snippet?.channelTitle || null,
              configured: true,
            }
          : { id, embeddable: false, title: null, channelTitle: null, configured: true };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'lookup failed', configured: true }));
      }
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
}).listen(PORT, () => console.log(`Bar4Bar dev server → http://localhost:${PORT}`));
