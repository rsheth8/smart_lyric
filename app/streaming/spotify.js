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
let currentTrack = null;
let pollTimer = null;
let lastTrackKey = '';
let positionSec = 0;
let playing = false;
let startedAt = 0;

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
      getPosition: () => {
        if (!playing) return positionSec;
        return positionSec + (performance.now() / 1000 - startedAt);
      },
      isPlaying: () => playing,
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
    artist: (t.artists || []).map((a) => a.name).join(', '),
    title: t.name,
    album: t.album?.name,
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
  };
  const key = `${meta.artist}::${meta.title}`;
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    currentTrack = meta;
    onTrackChange?.(meta);
  }
  playing = !!data.is_playing;
  // `progress_ms` was sampled by Spotify roughly one one-way trip before it
  // reached us. Advance the anchor by that estimate (half the round trip) so the
  // clock starts from where playback actually is *now*, not where it was — this
  // is the main reason highlighting otherwise runs consistently behind.
  const oneWaySec = playing ? rttSec / 2 : 0;
  positionSec = (data.progress_ms || 0) / 1000 + oneWaySec;
  startedAt = performance.now() / 1000;
  ensureClock();
}

async function pollOnce() {
  const token = await ensureFreshToken();
  if (!token) return;
  try {
    const reqStart = performance.now();
    const data = await fetchCurrentlyPlaying(token.access_token);
    const rttSec = (performance.now() - reqStart) / 1000;
    applyPlayerState(data, rttSec);
  } catch (e) {
    if (e.message === 'unauthorized') clearToken('spotify');
  }
}

function startPolling() {
  stopPolling();
  pollOnce();
  pollTimer = setInterval(pollOnce, 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
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
  if (window.smartLyric?.spotifyLogin) {
    const result = await window.smartLyric.spotifyLogin();
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

export async function connectSpotify({ onTrack, onError, onStatus }) {
  onTrackChange = onTrack;
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
  startPolling();
  onStatus?.('Following Spotify playback on any device…');
  return true;
}

export function disconnectSpotify() {
  stopPolling();
  streamingClock = null;
  currentTrack = null;
  lastTrackKey = '';
  playing = false;
  positionSec = 0;
  clearToken('spotify');
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
