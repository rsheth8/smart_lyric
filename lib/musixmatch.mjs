// Server-side Musixmatch "richsync" (word-level) fetcher.
//
// Musixmatch has no public richsync API — this uses the reverse-engineered
// desktop-app endpoint that karaoke apps use. ToS gray area, best-effort: coverage
// is mostly big Western pop (little/no Bollywood/Punjabi), and the token endpoint
// captcha-blocks under load — badly from datacenter IPs (Vercel). We therefore:
//   • cache the user token in-memory (valid ~10h) so token.get is called rarely,
//   • soft-fail to null on any block so the caller falls back to other providers.
// Most reliable from the long-running Electron main process (a residential IP).

const BASE = 'https://apic-desktop.musixmatch.com/ws/1.1';
const APP_ID = 'web-desktop-app-v1.0';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 9 * 60 * 60 * 1000; // refresh well before the ~10h expiry

let cachedToken = null;
let tokenExpiry = 0;
let cookieJar = '';

async function api(path, params = {}) {
  const qs = new URLSearchParams({ format: 'json', app_id: APP_ID, ...params });
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { 'User-Agent': UA, ...(cookieJar ? { Cookie: cookieJar } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Persist any cookies the endpoint sets (it uses them for rate-limit continuity).
  const sc = res.headers.get('set-cookie');
  if (sc) cookieJar = sc.split(/,(?=[^ ;]+=)/).map((s) => s.split(';')[0]).join('; ');
  if (!res.ok) return null;
  return res.json();
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const data = await api('token.get');
  const token = data?.message?.body?.user_token;
  // A captcha/rate-limit block returns no token — leave cache empty and bail.
  if (!token || token === 'UpgradeOnlyUpgrade') return null;
  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
  return token;
}

/**
 * @returns {Promise<{ richsync: string, meta: object }|null>} JSON richsync_body
 *   string + track meta, or null when unavailable/blocked.
 */
export async function fetchMusixmatchRichsync({ artist, track }) {
  if (!track) return null;
  const token = await getToken();
  if (!token) return null;

  const match = await api('matcher.track.get', {
    usertoken: token,
    q_track: track,
    q_artist: artist || '',
  });
  const t = match?.message?.body?.track;
  if (!t || !t.has_richsync || !t.track_id) return null;

  const rich = await api('track.richsync.get', { usertoken: token, track_id: String(t.track_id) });
  const body = rich?.message?.body?.richsync?.richsync_body;
  if (!body) return null;

  return {
    richsync: body,
    meta: {
      trackName: t.track_name,
      artistName: t.artist_name,
      albumName: t.album_name,
      duration: t.track_length,
    },
  };
}
