// YouTube URL parsing + official IFrame Player wrapper.
// Embeds only — no download / stream extraction. If a video disables embedding,
// callers should fall back to a local music-video file.

const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extract an 11-char video id from common YouTube URL shapes, or null.
 * @param {string} input
 * @returns {string|null}
 */
export function parseYouTubeId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (YT_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return YT_ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && YT_ID_RE.test(v)) return v;
    const parts = url.pathname.split('/').filter(Boolean);
    // /embed/ID, /shorts/ID, /live/ID, /v/ID
    if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
      return YT_ID_RE.test(parts[1]) ? parts[1] : null;
    }
  }
  return null;
}

/**
 * Best-effort split of a YouTube title into artist / track.
 * Handles "Artist - Song (Official Music Video)" style titles.
 * @param {string} title
 * @returns {{ artist: string, track: string }}
 */
export function parseYouTubeTitle(title) {
  let t = String(title || '').trim();
  t = t
    .replace(/\s*[\(\[\{]?\s*(official\s*)?(music\s*)?video\s*[\)\]\}]?\s*$/i, '')
    .replace(/\s*[\(\[\{]?\s*official\s*(audio|lyric\s*video|visualizer)\s*[\)\]\}]?\s*$/i, '')
    .replace(/\s*[\(\[\{]?\s*lyrics?\s*[\)\]\}]?\s*$/i, '')
    .trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), track: m[2].trim() };
  return { artist: '', track: t };
}

/**
 * Guess artist/track from a local media filename.
 * @param {string} name
 * @returns {{ artist: string, track: string }}
 */
export function guessMetaFromFilename(name) {
  const base = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return parseYouTubeTitle(base);
}

let apiPromise = null;

/** Load https://www.youtube.com/iframe_api once. */
export function loadYouTubeApi() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube API needs a browser'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        prior?.();
      } catch {
        /* ignore */
      }
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube IFrame API failed to load'));
    };
    if (!document.querySelector('script[data-yt-iframe-api]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.dataset.ytIframeApi = '1';
      s.onerror = () => reject(new Error('Could not load YouTube IFrame API'));
      document.head.appendChild(s);
    }
    // Already mid-load from another caller — wait for the global callback.
    setTimeout(() => {
      if (window.YT?.Player) resolve(window.YT);
    }, 8000);
  });
  return apiPromise;
}

/**
 * Create an official YouTube IFrame player in `hostEl`.
 * @param {HTMLElement} hostEl
 * @param {string} videoId
 * @param {{ onReady?: Function, onStateChange?: Function, onError?: Function }} [handlers]
 */
export async function createYouTubePlayer(hostEl, videoId, handlers = {}) {
  if (!hostEl) throw new Error('YouTube host element missing');
  if (!YT_ID_RE.test(videoId)) throw new Error('Invalid YouTube video id');

  const YT = await loadYouTubeApi();
  hostEl.innerHTML = '';
  const mount = document.createElement('div');
  hostEl.appendChild(mount);

  return new Promise((resolve, reject) => {
    let settled = false;
    const player = new YT.Player(mount, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        // Electron loads via file:// — YouTube rejects a file origin; omit it.
        ...(typeof location !== 'undefined' && /^https?:/.test(location.origin)
          ? { origin: location.origin }
          : {}),
      },
      events: {
        onReady: (e) => {
          settled = true;
          handlers.onReady?.(e);
          resolve(player);
        },
        onStateChange: (e) => handlers.onStateChange?.(e),
        onError: (e) => {
          handlers.onError?.(e);
          if (!settled) {
            settled = true;
            reject(new Error(youtubePlayerErrorMessage(e?.data)));
          }
        },
      },
    });
  });
}

/** Human message for YT.Player onError codes. */
export function youtubePlayerErrorMessage(code) {
  switch (Number(code)) {
    case 2:
      return 'Invalid YouTube video id.';
    case 5:
      return 'This video can’t play in HTML5.';
    case 100:
      return 'Video not found (removed or private).';
    case 101:
    case 150:
      return 'This video can’t be embedded. Open a local music-video file instead.';
    default:
      return 'YouTube playback failed.';
  }
}

/** YT.PlayerState.PLAYING === 1 */
export function isYouTubePlaying(player) {
  try {
    return player?.getPlayerState?.() === 1;
  } catch {
    return false;
  }
}

export function getYouTubeTime(player) {
  try {
    const t = player?.getCurrentTime?.();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Ask Electron (or a web /api) whether a video allows embedding.
 * Returns { embeddable, title, channelTitle } or null when lookup isn’t available.
 */
export async function lookupYouTubeVideo(videoId) {
  if (typeof window !== 'undefined' && window.bar4bar?.youtubeLookup) {
    return window.bar4bar.youtubeLookup(videoId);
  }
  try {
    const res = await fetch(`/api/youtube?id=${encodeURIComponent(videoId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
