// Art-adaptive accent: derive a per-song accent color from the album artwork
// while guaranteeing it stays legible on the espresso background.
//
// The risk this module exists to remove: a dark or muddy cover would otherwise
// hand us an accent that disappears against --surface-0, making the sung-word
// highlight unreadable. So we never use the extracted color directly — we take
// only its HUE, then rebuild the color at the brand's own lightness/chroma band
// (the same band #e3c27a sits in). The result always reads as "Dark Luxury,
// tinted toward this record" rather than "whatever color the cover was".
//
// Conversions are OKLab (Björn Ottosson) because it's perceptually uniform:
// clamping L there keeps every hue at the same apparent brightness, which sRGB
// HSL emphatically does not.

/** Brand fallback — champagne gold. Used whenever derivation can't be trusted. */
export const ACCENT_STATIC = '#e3c27a';

/** The espresso surface every accent must stay readable against. */
const SURFACE_0 = [0x0b, 0x09, 0x08];

// The band the brand gold occupies in OKLCh. Extracted accents are forced here.
const TARGET_L = 0.82; // lightness — same apparent brightness as #e3c27a
const MAX_C = 0.11; // chroma ceiling — beyond this the UI reads neon, not luxe
const MIN_CONTRAST = 4.5; // WCAG AA for large text, as a backstop assertion

// --- sRGB <-> linear ---------------------------------------------------------

function toLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function fromLinear(x) {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return c;
}

// --- linear sRGB <-> OKLab ---------------------------------------------------

function linearToOklab([r, g, b]) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToLinear([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** [r,g,b] 0-255 → { L, C, h } in OKLCh (h in radians). */
export function rgbToOklch(rgb) {
  const [L, a, b] = linearToOklab(rgb.map(toLinear));
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/**
 * { L, C, h } → [r,g,b] 0-255, reducing chroma until the color fits in sRGB.
 * Straight clipping of out-of-range channels shifts the hue; walking chroma
 * down preserves it, which is what keeps two similar covers from producing
 * visibly different accents.
 */
export function oklchToRgb({ L, C, h }) {
  let lo = 0;
  let hi = C;
  let best = null;

  // 12 bisection steps resolve chroma far finer than an 8-bit channel can show.
  for (let i = 0; i < 12; i++) {
    const c = (lo + hi) / 2;
    const lin = oklabToLinear([L, Math.cos(h) * c, Math.sin(h) * c]);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      best = lin;
      lo = c;
    } else {
      hi = c;
    }
  }
  // L alone can sit outside the gamut (it can't here — TARGET_L is safe — but
  // callers may pass anything), so fall back to the achromatic version.
  if (!best) best = oklabToLinear([L, 0, 0]);

  return best.map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(v))) * 255));
}

// --- contrast ----------------------------------------------------------------

/** WCAG relative luminance of an [r,g,b] 0-255 color. */
export function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG contrast ratio between two [r,g,b] colors (1–21). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --- the actual derivation ---------------------------------------------------

/**
 * Derive a legible accent from an album palette.
 *
 * @param {Array<number[]>|null} colors - dominant colors as [r,g,b] 0-255,
 *   i.e. exactly what `dominantColors()` / `paletteFromUrl()` in art.js return.
 * @param {{ targetL?: number, maxC?: number, fallback?: string }} [opts]
 * @returns {string} a hex color, guaranteed to clear MIN_CONTRAST on --surface-0.
 */
export function accentFromPalette(colors, opts = {}) {
  const { targetL = TARGET_L, maxC = MAX_C, fallback = ACCENT_STATIC } = opts;
  if (!Array.isArray(colors) || !colors.length) return fallback;

  // Pick the most colorful entry — the one whose hue actually says something
  // about the record. A near-grey cover has nothing to offer, so it falls back.
  let pick = null;
  let bestC = 0;
  for (const c of colors) {
    if (!Array.isArray(c) || c.length < 3 || c.some((v) => !Number.isFinite(v))) continue;
    const { C } = rgbToOklch(c);
    if (C > bestC) {
      bestC = C;
      pick = c;
    }
  }
  if (!pick || bestC < 0.02) return fallback;

  const { h } = rgbToOklch(pick);
  const rgb = oklchToRgb({ L: targetL, C: Math.min(bestC, maxC), h });

  // Backstop. The L clamp should make this unreachable; if the math is ever
  // changed it fails safe to brand gold instead of shipping unreadable lyrics.
  if (contrastRatio(rgb, SURFACE_0) < MIN_CONTRAST) return fallback;

  return toHex(rgb);
}

/**
 * A dimmer companion for the accent (borders, idle states) — same hue, lower L.
 * @param {string} hex
 * @returns {string}
 */
export function accentSoft(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return ACCENT_STATIC;
  const { C, h } = rgbToOklch(rgb);
  return toHex(oklchToRgb({ L: Math.min(0.93, TARGET_L + 0.11), C: C * 0.75, h }));
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Apply an accent to a root element as CSS custom properties. The CSS
 * transition on --accent is what makes it drift rather than snap.
 * @param {Element} root
 * @param {string|null} hex - null resets to the brand static accent.
 */
export function applyAccent(root, hex) {
  if (!root) return;
  const accent = hex || ACCENT_STATIC;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', accentSoft(accent));
}
