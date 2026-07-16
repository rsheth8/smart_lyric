// PKCE helpers + Spotify token exchange (no client secret required).

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-recently-played',
].join(' ');

export { SCOPES };

function randomString(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(plain) {
  const data = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair() {
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: state || '',
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export async function exchangeCode({ clientId, code, redirectUri, verifier, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Confidential clients may also send Basic auth; PKCE alone is enough for public clients.
  if (clientSecret) {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    token_type: data.token_type,
  };
}

export async function refreshAccessToken({ clientId, refreshToken, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) throw new Error(`Spotify refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

export function parseCallbackUrl(url) {
  const u = new URL(url);
  return {
    code: u.searchParams.get('code'),
    error: u.searchParams.get('error'),
    state: u.searchParams.get('state'),
  };
}
