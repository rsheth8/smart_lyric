// Spotify follow-mode: poll currently-playing on any device (phone, desktop, web).
// Auth uses Authorization Code + PKCE (implicit grant is deprecated by Spotify).

import { StreamingClock } from '../clock.js';
import { saveToken, loadToken, clearToken, isExpired } from './auth.js';
import {
  createPkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  parseCallbackUrl,
  SCOPES,
} from './pkce.js';

let streamingClock = null;
let onTrackChange = null;
let onStateChange = null;
let currentTrack = null;
let pollTimer = null;
let lastTrackKey = '';
let playing = false;
let firstPollTimer = null;

export function getSpotifyConfig() {
  return {
    clientId: window.__SL_CONFIG__?.spotifyClientId || '',
    redirectUri: window.__SL_CONFIG__?.spotifyRedirectUri || '',
  };
}

export function getStreamingClock() {
  return streamingClock;
}

export function getCurrentTrack() {
  return currentTrack;
}

function ensureClock() {
  if (!streamingClock) {
    streamingClock = new StreamingClock({
      isPlaying: () => playing,
      lead: SPOTIFY_LEAD_SEC,
    });
  }
  return streamingClock;
}

async function ensureFreshToken() {
  let token = loadToken('spotify');
  if (!token) return null;
  if (!isExpired(token)) return token;

  if (!token.refresh_token) {
    clearToken('spotify');
    return null;
  }
  const { clientId } = getSpotifyConfig();
  try {
    token = await refreshAccessToken({
      clientId,
      refreshToken: token.refresh_token,
    });
    saveToken('spotify', token);
    return token;
  } catch {
    clearToken('spotify');
    return null;
  }
}

async function fetchCurrentlyPlaying(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return null;
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) return null;
  return res.json();
}

function applyPlayerState(data, rttSec = 0) {
  if (!data?.item) {
    playing = false;
    return;
  }
  const t = data.item;
  const meta = {
    id: t.id,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    title: t.name,
    album: t.album?.name,
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
  };
  const key = `${meta.artist}::${meta.title}`;
  const trackChanged = key !== lastTrackKey;
  if (trackChanged) {
    lastTrackKey = key;
    currentTrack = meta;
    onTrackChange?.(meta);
  }
  const wasPlaying = playing;
  playing = !!data.is_playing;

  // `progress_ms` was sampled by Spotify roughly one one-way trip before it
  // reached us. Advance the measurement by that estimate (half the round trip)
  // so we correct toward where playback actually is *now*, not where it was.
  const oneWaySec = playing ? rttSec / 2 : 0;
  const measured = (data.progress_ms || 0) / 1000 + oneWaySec;

  const clock = ensureClock();
  // Snap on discontinuities (new track, just-resumed, paused); ease otherwise so
  // the ~1.5s poll cadence never shows up as a visible hitch in the highlight.
  if (!playing || trackChanged || (playing && !wasPlaying)) clock.set(measured);
  else clock.observe(measured);
}

async function pollOnce() {
  const token = await ensureFreshToken();
  if (!token) return;
  try {
    const reqStart = performance.now();
    const data = await fetchCurrentlyPlaying(token.access_token);
    const rttSec = (performance.now() - reqStart) / 1000;
    applyPlayerState(data, rttSec);
    onStateChange?.({ playing, position: streamingClock?.position() ?? 0, track: currentTrack });
  } catch (e) {
    if (e.message === 'unauthorized') clearToken('spotify');
  }
}

function startPolling(firstDelayMs = 0) {
  stopPolling();
  const begin = () => {
    pollOnce();
    pollTimer = setInterval(pollOnce, 1500);
  };
  // When we just started a track ourselves, Spotify's currently-playing can lag
  // for a moment; delaying the first poll avoids a flash of the previous song.
  if (firstDelayMs > 0) firstPollTimer = setTimeout(begin, firstDelayMs);
  else begin();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (firstPollTimer) clearTimeout(firstPollTimer);
  pollTimer = null;
  firstPollTimer = null;
}

/** Redirect URI for browser OAuth — must be allowlisted in Spotify Dashboard. */
export function browserRedirectUri() {
  const { protocol, hostname, port } = location;
  // Local dev must use the local origin, NOT the configured production URI:
  // Spotify rejects "localhost", and sending ?code= to Vercel would strand the
  // PKCE verifier (stored in this origin's sessionStorage). Register
  // http://127.0.0.1:4321/ in the Spotify Dashboard alongside the prod URI.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://127.0.0.1:${port || '4321'}/`;
  }

  // Production: prefer the configured URI (must match the Dashboard exactly).
  const configured = window.__SL_CONFIG__?.spotifyRedirectUri;
  if (configured) return configured.replace(/\/?$/, '/');
  return `${protocol}//${hostname}${port ? `:${port}` : ''}/`;
}

export async function beginSpotifyLogin() {
  const { clientId } = getSpotifyConfig();
  if (!clientId) throw new Error('SPOTIFY_CLIENT_ID missing. Add it to .env and restart.');

  // Electron: main-process auth popup (reliable)
  if (window.bar4bar?.spotifyLogin) {
    const result = await window.bar4bar.spotifyLogin();
    if (result?.error) throw new Error(result.error);
    if (!result?.access_token) throw new Error('Spotify login cancelled.');
    saveToken('spotify', {
      access_token: result.access_token,
      refresh_token: result.refresh_token || null,
      expires_at: result.expires_at,
    });
    return true;
  }

  // Browser: PKCE redirect
  const { verifier, challenge } = await createPkcePair();
  const state = randomState();
  sessionStorage.setItem('sl_spotify_verifier', verifier);
  sessionStorage.setItem('sl_spotify_state', state);
  const redirectUri = browserRedirectUri();
  location.href = buildAuthorizeUrl({
    clientId,
    redirectUri,
    challenge,
    state,
  });
  return false; // page will unload
}

function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Call on boot — completes browser PKCE if we landed with ?code= */
export async function completeSpotifyLoginFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (error) {
    history.replaceState(null, '', location.pathname);
    throw new Error(`Spotify auth error: ${error}`);
  }
  if (!code) return false;

  const verifier = sessionStorage.getItem('sl_spotify_verifier');
  const expectedState = sessionStorage.getItem('sl_spotify_state');
  const state = params.get('state');
  history.replaceState(null, '', location.pathname);
  if (!verifier) throw new Error('Missing PKCE verifier — try Connect Spotify again.');
  if (expectedState && state !== expectedState) throw new Error('Spotify state mismatch.');

  const { clientId } = getSpotifyConfig();
  const token = await exchangeCode({
    clientId,
    code,
    redirectUri: browserRedirectUri(),
    verifier,
  });
  sessionStorage.removeItem('sl_spotify_verifier');
  sessionStorage.removeItem('sl_spotify_state');
  saveToken('spotify', token);
  return true;
}

export async function connectSpotify({ onTrack, onError, onStatus, onState, firstPollDelayMs = 0 }) {
  onTrackChange = onTrack;
  onStateChange = onState || null;
  const { clientId } = getSpotifyConfig();
  if (!clientId) {
    onError?.('Spotify Client ID not configured. Set SPOTIFY_CLIENT_ID in .env and restart.');
    return false;
  }

  let token = await ensureFreshToken();
  if (!token) {
    onError?.('Spotify not connected. Authorization required.');
    return false;
  }

  ensureClock();
  startPolling(firstPollDelayMs);
  onStatus?.('Following Spotify playback on any device…');
  return true;
}

// Stop following (e.g. on song change / back to setup) but KEEP the auth token —
// otherwise picking another song would silently log the user out.
export function disconnectSpotify() {
  stopPolling();
  streamingClock = null;
  currentTrack = null;
  lastTrackKey = '';
  playing = false;
  onStateChange = null;
}

/** Full logout — drops the stored token. */
export function logoutSpotify() {
  disconnectSpotify();
  clearToken('spotify');
}

// --------------------------- playback control ----------------------------
// Spotify's currently-playing progress trails the device's actual audio output
// by a device-dependent buffer; nudge the clock forward so lyrics land on time.
// (The user can still fine-tune with the on-screen sync dial on top of this.)
const SPOTIFY_LEAD_SEC = 0.45;

/** Authenticated Spotify Web API call with friendly errors. Returns parsed JSON or null. */
async function playerApi(path, { method = 'GET', body } = {}) {
  const token = await ensureFreshToken();
  if (!token) throw new Error('Spotify isn’t connected. Connect Spotify and try again.');
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken('spotify');
    throw new Error('Spotify session expired. Connect Spotify again.');
  }
  if (res.status === 403) {
    throw new Error('Spotify Premium is required to control playback from the app.');
  }
  if (res.status === 404) {
    throw new Error('No active Spotify device. Open Spotify on your phone or computer, then try again.');
  }
  if (!res.ok && res.status !== 204) throw new Error(`Spotify error (${res.status}).`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Find a track on Spotify. Returns { uri, id, name, artist, album, artwork, duration } or null. */
export async function searchSpotifyTrack({ artist, track }) {
  if (!track) return null;

  // Primary artist only — "A, B" / feat. credits break Spotify's artist: filter.
  const primary = (artist || '')
    .split(',')[0]
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .trim();

  // Field filters first (precise), then a plain text fallback.
  const queries = [];
  if (primary) queries.push(`track:${track} artist:${primary}`);
  queries.push([track, primary].filter(Boolean).join(' '));

  let items = [];
  for (const q of queries) {
    const data = await playerApi(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    items = data?.tracks?.items || [];
    if (items.length) break;
  }
  if (!items.length) return null;

  const wantTrack = track.toLowerCase();
  const wantArtist = primary.toLowerCase();
  const scored = items.map((t) => {
    const name = (t.name || '').toLowerCase();
    const artists = (t.artists || []).map((a) => (a.name || '').toLowerCase());
    let score = 0;
    if (name === wantTrack) score += 3;
    else if (name.includes(wantTrack) || wantTrack.includes(name)) score += 2;
    else {
      const qw = new Set(wantTrack.split(/\s+/).filter(Boolean));
      const overlap = name.split(/\s+/).filter((w) => qw.has(w)).length;
      score += overlap / Math.max(qw.size, 1);
    }
    if (wantArtist && artists.some((a) => a.includes(wantArtist) || wantArtist.includes(a))) {
      score += 2;
    }
    // Prefer originals over live/karaoke noise when scores are close.
    if (/\b(live|karaoke|tribute|cover)\b/i.test(t.name || '')) score -= 1;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const t = scored[0].t;

  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name,
    artwork: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
  };
}

/** Pick an active device (transferring to one if none is active). Returns its id. */
async function ensureActiveDevice() {
  const data = await playerApi('/me/player/devices');
  const devices = data?.devices || [];
  if (!devices.length) {
    throw new Error('No Spotify device found. Open Spotify on your phone or computer, then try again.');
  }
  const active = devices.find((d) => d.is_active);
  if (active) return active.id;
  const target = devices[0];
  await playerApi('/me/player', { method: 'PUT', body: { device_ids: [target.id], play: false } });
  return target.id;
}

/** Start playing a track URI from the given position and anchor the clock immediately. */
export async function playSpotifyTrack({ uri, positionMs = 0 } = {}) {
  const deviceId = await ensureActiveDevice();
  await playerApi(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: { uris: [uri], position_ms: positionMs },
  });
  playing = true;
  ensureClock().set(positionMs / 1000);
  return deviceId;
}

export async function pausePlayback() {
  const clock = ensureClock();
  const at = clock.position(); // freeze at the current spot before pausing
  playing = false;
  clock.set(at);
  await playerApi('/me/player/pause', { method: 'PUT' });
}

export async function resumePlayback() {
  const clock = ensureClock();
  const at = clock.position();
  await playerApi('/me/player/play', { method: 'PUT' });
  playing = true;
  clock.set(at);
}

/** Toggle play/pause; returns the new playing state. */
export async function togglePlayback() {
  if (playing) await pausePlayback();
  else await resumePlayback();
  return playing;
}

export async function nextTrack() {
  await playerApi('/me/player/next', { method: 'POST' });
}

export async function previousTrack() {
  await playerApi('/me/player/previous', { method: 'POST' });
}

export async function seekTo(positionMs) {
  const ms = Math.max(0, Math.round(positionMs));
  await playerApi(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' });
  ensureClock().set(ms / 1000);
}

export function isSpotifyPlaying() {
  return playing;
}

/**
 * Pre-seed the "current track" so the first follow-poll doesn't re-fire a lyrics
 * reload for a song we just started ourselves.
 */
export function primeTrack(meta) {
  currentTrack = meta;
  lastTrackKey = `${meta.artist}::${meta.title || meta.name}`;
}

// Back-compat exports used by older UI wiring
export function buildSpotifyAuthUrl(redirectUri) {
  const { clientId } = getSpotifyConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export function parseSpotifyHashToken() {
  // Legacy implicit-grant helper — no longer used; keep for imports.
  return null;
}

export { parseCallbackUrl, createPkcePair, buildAuthorizeUrl, exchangeCode, SCOPES };
