// Spotify pairing for the Apple TV app. See lib/tv-pair.mjs for the handshake.
//
//   ?action=start      (TV)     mint a code + poll token
//   ?action=page       (phone)  the "enter your code" page, served at /tv
//   ?action=authorize  (phone)  code → 302 to Spotify
//   ?action=callback   (Spotify) exchange + stash tokens
//   ?action=poll       (TV)     redeem the tokens, once
//   ?action=refresh    (TV)     refresh an access token

import * as pair from '../lib/tv-pair.mjs';
import { isDurable, backend } from '../lib/pair-store.mjs';

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function originOf(req) {
  // Vercel always sets x-forwarded-proto; falling back to the socket rather
  // than to a hard-coded "https" is what keeps the local dev server from
  // printing an https:// pairing URL that nothing can open.
  const proto =
    req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, originOf(req));
  const action = url.searchParams.get('action') || 'page';
  const clientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  // Must match a Redirect URI registered on the Spotify app exactly.
  const redirectUri =
    (process.env.SPOTIFY_TV_REDIRECT_URI || '').trim() ||
    `${originOf(req)}/api/tv-pair?action=callback`;

  try {
    switch (action) {
      case 'start': {
        if (!clientId) {
          return json(res, 503, { error: 'SPOTIFY_CLIENT_ID is not set on this deployment.' });
        }
        if (!isDurable && process.env.VERCEL) {
          return json(res, 503, { error: "Spotify connection is temporarily unavailable. The pairing service needs to be configured." });
        }
        const started = await pair.start();
        return json(res, 200, {
          ...started,
          verifyURL: `${originOf(req)}/tv`,
          // What the TV renders as a QR code. Scanning it lands the phone on
          // Spotify's own consent screen with the code already applied — no URL
          // typed, no code transcribed, which is the entire point of putting a
          // camera-readable target on a television.
          scanURL: `${originOf(req)}/api/tv-pair?action=authorize&code=${encodeURIComponent(started.code)}`,
          // Surfaced so the TV can warn instead of silently failing to pair on
          // a serverless deployment with no shared store bound. `backend` is
          // here to make "which store did it actually pick up" answerable with
          // one curl rather than by reading env vars in a dashboard.
          durable: isDurable,
          backend,
        });
      }

      case 'page':
        return html(res, 200, pair.pairingPageHTML());

      case 'authorize': {
        const code = (url.searchParams.get('code') || '').trim().toUpperCase();
        const result = await pair.authorizeURL(code, { clientId, redirectUri });
        if (result.error) return html(res, 400, pair.pairingPageHTML({ error: result.error }));
        res.statusCode = 302;
        res.setHeader('Location', result.url);
        res.setHeader('Cache-Control', 'no-store');
        return res.end();
      }

      case 'callback': {
        const denied = url.searchParams.get('error');
        if (denied) {
          return html(res, 200, pair.pairingPageHTML({ error: `Spotify said: ${denied}` }));
        }
        const result = await pair.completeCallback({
          code: url.searchParams.get('code') || '',
          state: url.searchParams.get('state') || '',
          clientId,
          redirectUri,
        });
        if (result.error) return html(res, 400, pair.pairingPageHTML({ error: result.error }));
        return html(res, 200, pair.pairingPageHTML({ done: true }));
      }

      case 'poll': {
        const token = url.searchParams.get('token') || '';
        if (!token) return json(res, 400, { error: 'missing token' });
        return json(res, 200, await pair.poll(token));
      }

      case 'refresh': {
        const token = url.searchParams.get('refresh_token') || '';
        if (!token) return json(res, 400, { error: 'missing refresh_token' });
        const result = await pair.refresh(token, { clientId });
        return json(res, result.error ? (result.status || 502) : 200, result);
      }

      default:
        return json(res, 400, { error: `unknown action “${action}”` });
    }
  } catch (err) {
    console.error('TV pairing request failed:', err?.name || 'Error');
    return json(res, 503, { error: 'Spotify connection is temporarily unavailable. Please try again shortly.' });
  }
}
