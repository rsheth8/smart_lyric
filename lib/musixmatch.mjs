// Musixmatch word-level lyrics (richsync).
//
// Official Grow/Scale/Enterprise key (`MUSIXMATCH_API_KEY`) is the shipping
// path: match by ISRC / Spotify ID / Apple Music ID, then title. Grow forbids
// caching, so licensed hits are marked cacheable:false.
//
// Without a key, the reverse-engineered desktop token is a personal-use
// fallback. Vercel datacenter IPs are captcha-blocked; it is most reliable from
// Electron on a residential IP. Soft-fails so NetEase / prepared / LRCLIB run.

const OFFICIAL_BASE = 'https://api.musixmatch.com/ws/1.1';
const DESKTOP_BASE = 'https://apic-desktop.musixmatch.com/ws/1.1';
const APP_ID = 'web-desktop-app-v1.0';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 9 * 60 * 60 * 1000;

let cachedToken = null;
let tokenExpiry = 0;
let cookieJar = '';

export const officialApiKey = (env = process.env) => String(env.MUSIXMATCH_API_KEY || '').trim();

const finiteDuration = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n > 1000 ? n / 1000 : n) : undefined;
};

const pack = (body, track = {}, { licensed, fallback = {} }) => {
  if (!body) return null;
  return {
    richsync: body,
    licensed,
    cacheable: !licensed,
    meta: {
      trackName: track.track_name || fallback.track,
      artistName: track.artist_name || fallback.artist,
      albumName: track.album_name,
      duration: finiteDuration(track.track_length) ?? fallback.duration,
      isrc: track.track_isrc || fallback.isrc,
    },
  };
};

export async function fetchMusixmatchRichsync(query = {}, { env = process.env, fetcher = fetch } = {}) {
  const artist = String(query.artist || '');
  const track = String(query.track || '');
  const isrc = String(query.isrc || '').toUpperCase();
  const spotifyID = String(query.spotifyID || query.spotifyId || '');
  const appleMusicID = String(query.appleMusicID || query.appleMusicId || '');
  if (!track && !isrc && !spotifyID && !appleMusicID) return null;
  const key = officialApiKey(env);
  if (key) {
    return fetchOfficial({ artist, track, isrc, spotifyID, appleMusicID, duration: query.duration, key, fetcher });
  }
  return fetchDesktop({ artist, track, fetcher });
}

async function officialGet(path, params, { key, fetcher }) {
  const qs = new URLSearchParams({ format: 'json', apikey: key, ...params });
  const res = await fetcher(`${OFFICIAL_BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.message?.header?.status_code !== 200) return null;
  return data.message.body;
}

async function fetchOfficial({ artist, track, isrc, spotifyID, appleMusicID, duration, key, fetcher }) {
  const length = finiteDuration(duration);
  const ids = [
    isrc && { track_isrc: isrc },
    spotifyID && { track_spotify_id: spotifyID },
    appleMusicID && { track_itunes_id: appleMusicID },
  ].filter(Boolean);

  for (const id of ids) {
    const params = { ...id };
    if (length) {
      params.f_richsync_length = String(Math.round(length));
      params.f_richsync_length_max_deviation = '2';
    }
    const body = await officialGet('track.richsync.get', params, { key, fetcher });
    const packed = pack(body?.richsync?.richsync_body, body?.richsync || {}, {
      licensed: true, fallback: { artist, track, duration, isrc },
    });
    if (packed) return packed;
  }

  const matchParams = {};
  if (track) matchParams.q_track = track;
  if (artist) matchParams.q_artist = artist;
  if (isrc) matchParams.track_isrc = isrc;
  if (!matchParams.q_track && !matchParams.track_isrc) return null;
  const matched = await officialGet('matcher.track.get', matchParams, { key, fetcher });
  const t = matched?.track;
  if (!t || !(t.has_richsync || t.commontrack_id || t.track_id)) return null;
  const id = t.commontrack_id
    ? { commontrack_id: String(t.commontrack_id) }
    : { track_id: String(t.track_id) };
  const rich = await officialGet('track.richsync.get', id, { key, fetcher });
  return pack(rich?.richsync?.richsync_body, { ...t, ...rich?.richsync }, {
    licensed: true, fallback: { artist, track, duration, isrc },
  });
}

async function desktopApi(path, params, fetcher) {
  const qs = new URLSearchParams({ format: 'json', app_id: APP_ID, ...params });
  const res = await fetcher(`${DESKTOP_BASE}/${path}?${qs}`, {
    headers: { 'User-Agent': UA, ...(cookieJar ? { Cookie: cookieJar } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const sc = res.headers.get?.('set-cookie');
  if (sc) cookieJar = sc.split(/,(?=[^ ;]+=)/).map(s => s.split(';')[0]).join('; ');
  if (!res.ok) return null;
  return res.json();
}

async function getToken(fetcher) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const data = await desktopApi('token.get', {}, fetcher);
  const token = data?.message?.body?.user_token;
  if (!token || token === 'UpgradeOnlyUpgrade') return null;
  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
  return token;
}

async function fetchDesktop({ artist, track, fetcher }) {
  if (!track) return null;
  const token = await getToken(fetcher);
  if (!token) return null;
  const match = await desktopApi('matcher.track.get', {
    usertoken: token, q_track: track, q_artist: artist || '',
  }, fetcher);
  const t = match?.message?.body?.track;
  if (!t || !t.has_richsync || !t.track_id) return null;
  const rich = await desktopApi('track.richsync.get', {
    usertoken: token, track_id: String(t.track_id),
  }, fetcher);
  return pack(rich?.message?.body?.richsync?.richsync_body, t, { licensed: false });
}
