// Public recommendations (iTunes charts) + search suggestions (iTunes Search).
// Spotify recently-played is loaded separately when a token is available.

const ITUNES_TOP = 'https://itunes.apple.com/us/rss/topsongs/limit=12/json';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';

function mapItunesEntry(entry) {
  const track = entry['im:name']?.label || entry.trackName || '';
  const artist = entry['im:artist']?.label || entry.artistName || '';
  const artwork =
    entry['im:image']?.[2]?.label ||
    entry.artworkUrl100 ||
    entry['im:image']?.[0]?.label ||
    '';
  return { track, artist, artwork, source: 'itunes' };
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
        artwork: (r.artworkUrl100 || '').replace('100x100', '200x200'),
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
          artwork: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
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
      artwork: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
      progressMs: data.progress_ms || 0,
      isPlaying: !!data.is_playing,
      source: 'spotify',
    };
  } catch {
    return null;
  }
}
