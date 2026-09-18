// Serves runtime config for the static frontend (Spotify client id, etc.).
// Used locally via rewrite isn't needed — server.mjs handles /config.js.
// On Vercel: /config.js → /api/config

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const config = {
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    appleMusicDeveloperToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN || '',
    // Optional override; otherwise the page uses location.origin + "/"
    spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
    youtubeConfigured: !!(process.env.YOUTUBE_API_KEY || '').trim(),
  };

  res.statusCode = 200;
  res.end(`window.__SL_CONFIG__ = ${JSON.stringify(config)};`);
}
