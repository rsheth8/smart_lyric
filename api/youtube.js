// YouTube Data API proxy for the web build. Electron uses IPC instead.
// GET /api/youtube?id=VIDEO_ID → { id, embeddable, title, channelTitle, configured }

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  const id = String(req.query?.id || '').trim();

  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid id', configured: !!key }));
    return;
  }
  if (!key) {
    res.statusCode = 200;
    res.end(JSON.stringify({ id, embeddable: null, title: null, channelTitle: null, configured: false }));
    return;
  }

  try {
    const url =
      'https://www.googleapis.com/youtube/v3/videos' +
      `?part=status,snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.statusCode = upstream.status;
      res.end(JSON.stringify({ error: `YouTube API ${upstream.status}`, configured: true }));
      return;
    }
    const data = await upstream.json();
    const item = data?.items?.[0];
    if (!item) {
      res.statusCode = 200;
      res.end(JSON.stringify({ id, embeddable: false, title: null, channelTitle: null, configured: true }));
      return;
    }
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        id,
        embeddable: item.status?.embeddable !== false,
        title: item.snippet?.title || null,
        channelTitle: item.snippet?.channelTitle || null,
        configured: true,
      })
    );
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message || 'lookup failed', configured: true }));
  }
}
