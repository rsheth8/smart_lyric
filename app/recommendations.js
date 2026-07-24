// Public recommendations (iTunes charts) + search suggestions (iTunes Search).
// Spotify recently-played is loaded separately when a token is available.

import { upgradeArtwork } from './art.js';

const ITUNES_TOP = 'https://itunes.apple.com/us/rss/topsongs/limit=12/json';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';

// Poster cards are --card-w (168px desktop / 260px TV) and displays are 2×, so a
// shelf card needs up to ~520 real pixels. The chart RSS only offers 170px art
// and Search only 100px, both of which visibly mush at that size — ask the CDN
// for a rendition that actually fits. List rows stay small; they share the same
// cached asset, so one size for both is cheaper than two fetches.
const CARD_ART = 600;

// Spotify orders album images LARGEST first, so images[1] is the 300px
// rendition — too small for a poster card on a 2x display. Take [0] (640px).
function spotifyArt(images) {
  return images?.[0]?.url || images?.[1]?.url || '';
}

function mapItunesEntry(entry) {
  const track = entry['im:name']?.label || entry.trackName || '';
  const artist = entry['im:artist']?.label || entry.artistName || '';
  const artwork =
    entry['im:image']?.[2]?.label ||
    entry.artworkUrl100 ||
    entry['im:image']?.[0]?.label ||
    '';
  return { track, artist, artwork: upgradeArtwork(artwork, CARD_ART), source: 'itunes' };
}

export async function fetchChartRecommendations() {
  try {
    const res = await fetch(ITUNES_TOP, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.feed?.entry || []).map(mapItunesEntry).filter((x) => x.track);
  } catch {
    return [];
  }
}

export async function searchSuggestions(query, { limit = 8 } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const params = new URLSearchParams({
      term: q,
      media: 'music',
      entity: 'song',
      limit: String(limit),
    });
    const res = await fetch(`${ITUNES_SEARCH}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .map((r) => ({
        track: r.trackName || '',
        artist: r.artistName || '',
        artwork: upgradeArtwork(r.artworkUrl100, CARD_ART),
        duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
        source: 'itunes',
      }))
      .filter((x) => x.track);
  } catch {
    return [];
  }
}

export async function fetchSpotifyRecentlyPlayed(accessToken, { limit = 8 } = {}) {
  if (!accessToken) return [];
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || [])
      .map((item) => {
        const t = item.track;
        if (!t) return null;
        return {
          track: t.name || '',
          artist: (t.artists || []).map((a) => a.name).join(', '),
          artwork: spotifyArt(t.album?.images),
          duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
          source: 'spotify',
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function fetchSpotifyNowPlaying(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 204 || !res.ok) return null;
    const data = await res.json();
    const t = data.item;
    if (!t) return null;
    return {
      track: t.name || '',
      artist: (t.artists || []).map((a) => a.name).join(', '),
      artwork: spotifyArt(t.album?.images),
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
      progressMs: data.progress_ms || 0,
      isPlaying: !!data.is_playing,
      source: 'spotify',
    };
  } catch {
    return null;
  }
}
