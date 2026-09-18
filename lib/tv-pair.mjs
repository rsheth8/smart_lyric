// Spotify "connect on your phone" pairing for the Apple TV app.
//
// tvOS has no browser and no `ASWebAuthenticationSession`, and Spotify does not
// implement OAuth device-code flow, so the TV cannot run the authorization
// itself. The handshake instead is:
//
//   1. TV    → POST  /api/tv-pair?action=start   → { code: "K7M-3QP", pollToken }
//   2. TV shows the code; viewer opens /tv on a phone and types it in
//   3. phone → GET   /api/tv-pair?action=authorize&code=K7M-3QP  → 302 to Spotify
//   4. Spotify → GET /api/tv-pair?action=callback&code=…&state=… → tokens stored
//   5. TV    → GET   /api/tv-pair?action=poll&token=…  → the tokens, once
//
// PKCE throughout, so there is no client secret anywhere and nothing secret
// ships in the tvOS binary — the TV never learns the client id either. The
// verifier lives with the pairing record, server-side, for its whole 10 minutes.

import { randomBytes, createHash } from 'node:crypto';
import * as store from './pair-store.mjs';

export const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

/** Long enough to walk to your phone, short enough that a leaked code is dead. */
const PAIR_TTL_SEC = 600;
/** The tokens sit here only until the TV's next poll, ~2 s later. */
const RESULT_TTL_SEC = 300;

// No I/O/0/1: these get read off a television across a room and typed on a
// phone, and confusing a zero for an O is the whole failure mode.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode() {
  const bytes = randomBytes(6);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 3).join('')}-${chars.slice(3).join('')}`;
}

function urlSafe(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeVerifier() {
  return urlSafe(randomBytes(48));
}

function challengeFor(verifier) {
  return urlSafe(createHash('sha256').update(verifier).digest());
}

const codeKey = (code) => `tvpair:code:${code.toUpperCase()}`;
const tokenKey = (token) => `tvpair:poll:${token}`;

/**
 * Step 1 — the TV asks for a code.
 * @returns {Promise<{code: string, pollToken: string, expiresIn: number}>}
 */
export async function start() {
  const code = makeCode();
  const pollToken = urlSafe(randomBytes(24));
  const verifier = makeVerifier();

  const record = { code, pollToken, verifier, status: 'pending', createdAt: Date.now() };
  await store.put(codeKey(code), record, PAIR_TTL_SEC);
  // Indexed both ways: the phone arrives with the code, the TV polls with the
  // token, and neither should be able to derive the other.
  await store.put(tokenKey(pollToken), { code }, PAIR_TTL_SEC);

  return { code, pollToken, expiresIn: PAIR_TTL_SEC };
}

/**
 * Step 3 — the phone submits the code. Returns the Spotify authorize URL.
 * @returns {Promise<{url: string} | {error: string}>}
 */
export async function authorizeURL(code, { clientId, redirectUri }) {
  if (!clientId) return { error: 'Spotify is not configured on this server.' };
  const record = await store.get(codeKey(code));
  if (!record) return { error: 'That code has expired or was never issued.' };

  // `state` is the pairing code itself, which is what lets the callback find
  // the record again — Spotify hands state back verbatim.
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state: record.code,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challengeFor(record.verifier),
  });
  return { url: `https://accounts.spotify.com/authorize?${params}` };
}

/**
 * Step 4 — Spotify redirects the phone back here. Exchanges and stores tokens.
 * @returns {Promise<{ok: true} | {error: string}>}
 */
export async function completeCallback({ code, state, clientId, redirectUri }) {
  const record = await store.get(codeKey(state || ''));
  if (!record) return { error: 'This pairing session has expired. Start again on your Apple TV.' };

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: record.verifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { error: `Spotify rejected the sign-in (${res.status}). ${detail.slice(0, 160)}` };
  }
  const tokens = await res.json();

  await store.put(
    codeKey(record.code),
    {
      ...record,
      status: 'ready',
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
      },
    },
    RESULT_TTL_SEC
  );
  return { ok: true };
}

/**
 * Step 5 — the TV polls. Tokens are handed out exactly once, then the record is
 * destroyed: a poll token that leaked after the fact must be worthless.
 * @returns {Promise<{status: 'pending'} | {status: 'ready', tokens: object} | {status: 'expired'}>}
 */
export async function poll(pollToken) {
  const index = await store.get(tokenKey(pollToken));
  if (!index) return { status: 'expired' };
  const record = await store.get(codeKey(index.code));
  if (!record) return { status: 'expired' };
  if (record.status !== 'ready') return { status: 'pending' };

  await store.del(codeKey(index.code));
  await store.del(tokenKey(pollToken));
  return { status: 'ready', tokens: record.tokens };
}

/**
 * Refresh an access token on the TV's behalf.
 *
 * Done here rather than on the device so the client id stays server-side. It is
 * a public value under PKCE, but keeping it out of the binary means rotating it
 * never requires shipping an app update.
 */
export async function refresh(refreshToken, { clientId }) {
  if (!clientId) return { error: 'Spotify is not configured on this server.' };
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return { error: detail.error === 'invalid_grant' ? 'Spotify sign-in expired. Connect again.' : 'Spotify could not reconnect. Try again shortly.', status: detail.error === 'invalid_grant' ? 401 : 502 };
  }
  const tokens = await res.json();
  return {
    access_token: tokens.access_token,
    // Spotify only re-issues a refresh token sometimes; keep the old one when
    // it doesn't, or the next refresh has nothing to present.
    refresh_token: tokens.refresh_token || refreshToken,
    expires_in: tokens.expires_in,
  };
}

/** The page the viewer opens on their phone. */
export function pairingPageHTML({ error = '', done = false } = {}) {
  const body = done
    ? `<h1>You're connected</h1>
       <p>Look back at your Apple TV — you can pause, skip, and follow the words from there. You can close this page.</p>`
    : `<h1>Connect Spotify</h1>
       <p>Enter the code shown on your Apple TV.</p>
       ${error ? `<p class="err">${escapeHTML(error)}</p>` : ''}
       <form method="GET" action="/api/tv-pair">
         <input type="hidden" name="action" value="authorize" />
         <input name="code" inputmode="text" autocapitalize="characters" autocomplete="off"
                spellcheck="false" placeholder="K7M-3QP" maxlength="7" required aria-label="Pairing code" />
         <button type="submit">Continue</button>
       </form>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Bar4Bar · Connect Spotify</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px;
    background: #0B0908; color: #F6F0E4;
    font: 400 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  main { width: 100%; max-width: 380px; text-align: center; }
  .mark {
    width: 64px; height: 64px; margin: 0 auto 24px; display: grid; place-items: center;
    border-radius: 13px; background: #0B0908; border: 1px solid rgba(227,194,122,.46);
    box-shadow: 0 0 24px rgba(227,194,122,.2);
    font-weight: 800; font-size: 19px; letter-spacing: -.04em; color: #F4E3BD;
  }
  /* One grid item, not three: place-items would otherwise treat "B", the
     italic 4, and "B" as separate grid items and stack them vertically. */
  .mark span { display: block; }
  .mark i { color: #FF715B; font-style: normal; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 8px; }
  p { color: rgba(246,240,228,.62); margin: 0 0 24px; }
  .err { color: #FF715B; }
  input {
    width: 100%; height: 60px; text-align: center; font-size: 28px; font-weight: 700;
    letter-spacing: .18em; text-transform: uppercase;
    color: #F6F0E4; background: rgba(255,255,255,.065);
    border: 1px solid rgba(255,255,255,.14); border-radius: 16px; margin-bottom: 12px;
  }
  input:focus { outline: none; border-color: #E3C27A; background: rgba(255,255,255,.1); }
  input::placeholder { color: rgba(246,240,228,.28); letter-spacing: .18em; }
  button {
    width: 100%; height: 60px; font-size: 18px; font-weight: 600; color: #171106;
    background: linear-gradient(135deg, #F4E3BD, #E3C27A);
    border: 0; border-radius: 16px; cursor: pointer;
  }
  button:active { transform: scale(.985); }
</style>
</head><body><main>
<div class="mark"><span>B<i>4</i>B</span></div>
${body}
</main></body></html>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
