// Album artwork → the palette that colors the ambient background glow.
//
// Source: the free iTunes Search API (no key, CORS-enabled). We take the cover,
// draw it to an offscreen canvas, and extract a few dominant, vivid colors.
//
// `dominantColors` is a pure function (no DOM) so it can be unit-tested; the
// fetch/canvas plumbing around it is browser-only and degrades gracefully.

// --- pure: pick N dominant, reasonably-saturated colors from RGBA pixel data ---
// `data` is a flat [r,g,b,a, r,g,b,a, ...] array (Uint8ClampedArray or number[]).
export function dominantColors(data, { count = 3, step = 4, bits = 4 } = {}) {
  const shift = 8 - bits; // quantize each channel to `bits` levels
  const buckets = new Map();

  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue; // skip transparent

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    // Ignore near-black, near-white, and washed-out pixels — they make dull glows.
    if (lum < 0.08 || lum > 0.95) continue;

    const key = (r >> shift) + '|' + (g >> shift) + '|' + (b >> shift);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { r: 0, g: 0, b: 0, n: 0, score: 0 }));
    e.r += r; e.g += g; e.b += b; e.n += 1;
    // Weight by saturation so vivid colors win over muddy ones.
    e.score += 1 + sat * 2.5;
  }

  const ranked = [...buckets.values()].sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const e of ranked) {
    const c = [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
    // Keep colors visually distinct so the glow isn't three shades of one hue.
    if (chosen.every((p) => colorDist(p, c) > 60)) chosen.push(c);
    if (chosen.length >= count) break;
  }
  // Pad from the ranked list if distinctness filtering left us short.
  for (const e of ranked) {
    if (chosen.length >= count) break;
    chosen.push([Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);
  }
  return chosen;
}

export function colorDist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Ask iTunes for a bigger rendition of an artwork URL.
 *
 * Every iTunes artwork URL ends in `/<w>x<h>bb.<ext>` and the CDN will serve any
 * size and either extension you name. The catalog APIs hand back 100–170px
 * thumbnails, which look fine in a list row and visibly mushy on a poster card —
 * a 170px source in a 260px card on a 2× display is a 3× upscale.
 *
 * The extension is forced to .jpg because the chart RSS hands out .png URLs, and
 * at 600px the same cover is ~287KB as PNG vs ~105KB as JPEG. Album art is
 * photographic; PNG buys nothing here and the hub loads twelve of them.
 *
 * @param {string} url
 * @param {number} [size] - square edge in pixels
 * @returns {string} the resized URL, or the input unchanged if it isn't iTunes
 */
export function upgradeArtwork(url, size = 600) {
  if (!url) return '';
  return url.replace(/\/\d+x\d+bb\.(?:png|jpg|jpeg)$/i, `/${size}x${size}bb.jpg`);
}

// --- browser: find a cover art URL for a track via the iTunes Search API ---
export async function fetchArtworkUrl({ artist, track }) {
  const term = encodeURIComponent([artist, track].filter(Boolean).join(' '));
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.results && data.results[0];
    if (!hit || !hit.artworkUrl100) return null;
    return upgradeArtwork(hit.artworkUrl100);
  } catch (e) {
    console.warn('artwork lookup failed:', e);
    return null;
  }
}

// --- browser: load an image URL and extract its palette ---
export function paletteFromUrl(url, opts = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 64; // downsample for speed
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, size, size);
        const { data } = cx.getImageData(0, 0, size, size);
        resolve(dominantColors(data, { step: 1, ...opts }));
      } catch (e) {
        console.warn('palette extraction failed (CORS?):', e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
