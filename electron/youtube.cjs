// YouTube Data API v3 — embeddability + title lookup. Key stays in main.
// Embeds themselves use the official IFrame Player; this only answers
// "may we show this video?" before creating the player.

function configured() {
  return !!(process.env.YOUTUBE_API_KEY || '').trim();
}

/**
 * @param {string} videoId
 * @returns {Promise<{ id: string, embeddable: boolean|null, title: string|null, channelTitle: string|null, configured: boolean }>}
 */
async function lookupVideo(videoId) {
  const id = String(videoId || '').trim();
  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return { id, embeddable: false, title: null, channelTitle: null, configured: !!key };
  }
  if (!key) {
    return { id, embeddable: null, title: null, channelTitle: null, configured: false };
  }

  const url =
    'https://www.googleapis.com/youtube/v3/videos' +
    `?part=status,snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  const data = await res.json();
  const item = data?.items?.[0];
  if (!item) {
    return { id, embeddable: false, title: null, channelTitle: null, configured: true };
  }
  return {
    id,
    embeddable: item.status?.embeddable !== false,
    title: item.snippet?.title || null,
    channelTitle: item.snippet?.channelTitle || null,
    configured: true,
  };
}

module.exports = { configured, lookupVideo };
