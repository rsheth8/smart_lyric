// Server-side Genius lyrics fetcher (plain text only).
//
// Genius has NO public lyrics API — the /search endpoint (token-gated) returns
// the song URL, and the actual words live in the HTML page, which we scrape.
// This runs ONLY server-side (Vercel fn / local dev server / Electron main): the
// token stays secret and the page fetch would be CORS-blocked in a browser.
//
// Requires GENIUS_ACCESS_TOKEN. Without it, this provider is skipped entirely.
// NOTE: scraping the lyric page is contrary to Genius's ToS — this is a
// best-effort last resort for personal use; treat coverage as unreliable.

const API = 'https://api.genius.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;

function canonical(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function searchSong({ artist, track, token }) {
  const q = [track, artist].filter(Boolean).join(' ');
  const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const hits = (data?.response?.hits || []).filter((h) => h.type === 'song').map((h) => h.result);
  if (!hits.length) return null;

  const wantT = canonical(track);
  const wantA = canonical(artist);
  let best = null;
  let bestScore = -1;
  for (const h of hits) {
    const title = canonical(h.title);
    const primary = canonical(h.primary_artist?.name);
    let score = 0;
    if (title === wantT) score += 2;
    else if (title.includes(wantT) || wantT.includes(title)) score += 1;
    if (wantA && (primary.includes(wantA) || wantA.includes(primary))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return bestScore >= 1 ? best : null;
}

// Grab the inner HTML of each <div …> whose opening tag matches `openRe`,
// balancing nested <div>/</div> so we don't truncate at the first close tag.
function balancedDivs(html, openRe) {
  const re = new RegExp(openRe.source, 'g');
  const tag = /<\/?div\b[^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    tag.lastIndex = start;
    let depth = 1;
    let t;
    while (depth > 0 && (t = tag.exec(html)) !== null) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        out.push({ inner: html.slice(start, t.index), end: tag.lastIndex });
        re.lastIndex = tag.lastIndex; // continue past this whole subtree
        break;
      }
    }
  }
  return out;
}

const CONTAINER_RE = /<div\b[^>]*data-lyrics-container="true"[^>]*>/i;
const EXCLUDE_RE = /<div\b[^>]*data-exclude-from-selection="true"[^>]*>/i;

// Extract lyric text from the song page HTML. Genius renders lyrics inside
// <div data-lyrics-container="true">…</div> with <br> line breaks; non-lyric UI
// (contributor/translation header, ads) is nested and marked
// data-exclude-from-selection="true" — we drop those subtrees.
export function extractLyricsFromHtml(html) {
  const containers = balancedDivs(html, CONTAINER_RE);
  if (!containers.length) return '';

  const cleaned = containers.map(({ inner }) => {
    // Remove each excluded subtree (balanced) from the container.
    let out = inner;
    for (const ex of balancedDivs(inner, EXCLUDE_RE)) {
      out = out.replace(ex.inner, '');
    }
    return out.replace(EXCLUDE_RE, ''); // drop the now-empty opening tags too
  });

  const text = cleaned
    .join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '') // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ');

  // Drop section headers like [Chorus], [Verse 1] and squeeze blank runs.
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^\[.*\]$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @returns {Promise<{ plain: string, meta: object }|null>}
 */
export async function fetchGeniusLyrics({ artist, track }, token = process.env.GENIUS_ACCESS_TOKEN) {
  if (!token || !track) return null;
  const song = await searchSong({ artist, track, token });
  if (!song?.url) return null;

  const page = await fetch(song.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!page.ok) return null;
  const html = await page.text();
  const plain = extractLyricsFromHtml(html);
  if (!plain) return null;

  return {
    plain,
    meta: {
      trackName: song.title,
      artistName: song.primary_artist?.name,
      geniusId: song.id,
    },
  };
}
