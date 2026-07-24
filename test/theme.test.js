import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  accentFromPalette,
  accentSoft,
  contrastRatio,
  hexToRgb,
  rgbToOklch,
  oklchToRgb,
  ACCENT_STATIC,
} from '../app/theme.js';

const SURFACE_0 = [0x0b, 0x09, 0x08];
const MIN_CONTRAST = 4.5;

describe('theme — art-adaptive accent', () => {
  test('falls back to brand gold without a palette', () => {
    assert.equal(accentFromPalette(null), ACCENT_STATIC);
    assert.equal(accentFromPalette([]), ACCENT_STATIC);
    assert.equal(accentFromPalette(undefined), ACCENT_STATIC);
  });

  test('falls back when the cover is essentially greyscale', () => {
    // A black-and-white sleeve has no hue worth borrowing.
    assert.equal(accentFromPalette([[128, 128, 128], [60, 60, 61]]), ACCENT_STATIC);
  });

  test('ignores malformed entries instead of throwing', () => {
    assert.equal(accentFromPalette([null, [1, 2], ['a', 'b', 'c']]), ACCENT_STATIC);
  });

  test('every derived accent clears WCAG AA on the espresso surface', () => {
    // The whole point of the module: no cover may produce unreadable lyrics.
    const covers = [
      [[8, 8, 12]], // near-black sleeve
      [[16, 24, 90]], // deep navy
      [[120, 10, 10]], // dark blood red
      [[250, 240, 200]], // washed-out cream
      [[0, 90, 40]], // forest green
      [[90, 20, 120]], // purple
      [[255, 0, 0]], // saturated red
      [[0, 0, 255]], // saturated blue — the hardest case, darkest hue
    ];
    for (const palette of covers) {
      const hex = accentFromPalette(palette);
      const ratio = contrastRatio(hexToRgb(hex), SURFACE_0);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${JSON.stringify(palette[0])} → ${hex} has contrast ${ratio.toFixed(2)}`
      );
    }
  });

  test('clamps chroma so a neon cover cannot produce a neon accent', () => {
    const hex = accentFromPalette([[255, 0, 255]]);
    const { C } = rgbToOklch(hexToRgb(hex));
    assert.ok(C <= 0.115, `chroma ${C.toFixed(3)} exceeded the ceiling`);
  });

  test('normalizes lightness across wildly different covers', () => {
    // A dark cover and a bright cover should yield accents of the SAME apparent
    // brightness — only the hue differs. That's what keeps the look coherent.
    const dark = rgbToOklch(hexToRgb(accentFromPalette([[20, 8, 4]])));
    const bright = rgbToOklch(hexToRgb(accentFromPalette([[255, 210, 120]])));
    assert.ok(Math.abs(dark.L - bright.L) < 0.01, `${dark.L} vs ${bright.L}`);
  });

  test('preserves the hue it borrowed', () => {
    const source = [200, 40, 40]; // red
    const hex = accentFromPalette([source]);
    const srcHue = rgbToOklch(source).h;
    const outHue = rgbToOklch(hexToRgb(hex)).h;
    // Within ~6 degrees; chroma reduction for gamut fitting shifts it slightly.
    assert.ok(Math.abs(srcHue - outHue) < 0.1, `hue drifted ${srcHue} → ${outHue}`);
  });

  test('picks the most colorful entry, not the first', () => {
    const greyFirst = accentFromPalette([[90, 90, 90], [200, 40, 40]]);
    const redOnly = accentFromPalette([[200, 40, 40]]);
    assert.equal(greyFirst, redOnly);
  });

  test('accentSoft is lighter than the accent and stays in gamut', () => {
    const accent = accentFromPalette([[200, 40, 40]]);
    const soft = accentSoft(accent);
    assert.ok(rgbToOklch(hexToRgb(soft)).L > rgbToOklch(hexToRgb(accent)).L);
    assert.match(soft, /^#[0-9a-f]{6}$/);
  });

  test('accentSoft falls back on a malformed color', () => {
    assert.equal(accentSoft('not-a-color'), ACCENT_STATIC);
  });
});

describe('theme — color math', () => {
  test('oklch round-trips through rgb', () => {
    for (const rgb of [[227, 194, 122], [12, 200, 90], [255, 255, 255], [0, 0, 0]]) {
      const back = oklchToRgb(rgbToOklch(rgb));
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(back[i] - rgb[i]) <= 2, `${rgb} → ${back}`);
      }
    }
  });

  test('contrastRatio is symmetric and bounded', () => {
    assert.ok(Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 0.01);
    assert.equal(contrastRatio([10, 20, 30], [200, 100, 50]), contrastRatio([200, 100, 50], [10, 20, 30]));
    assert.equal(contrastRatio([50, 50, 50], [50, 50, 50]), 1);
  });

  test('hexToRgb tolerates a missing hash and rejects junk', () => {
    assert.deepEqual(hexToRgb('#e3c27a'), [227, 194, 122]);
    assert.deepEqual(hexToRgb('e3c27a'), [227, 194, 122]);
    assert.equal(hexToRgb('#fff'), null);
    assert.equal(hexToRgb(null), null);
  });

  test('the brand gold itself survives the derivation unchanged in spirit', () => {
    // Feeding the brand color back in should land within a hair of it —
    // proof the TARGET_L/MAX_C band was chosen to match #e3c27a.
    const hex = accentFromPalette([[227, 194, 122]]);
    const a = rgbToOklch(hexToRgb(hex));
    const b = rgbToOklch([227, 194, 122]);
    assert.ok(Math.abs(a.L - b.L) < 0.03, `L ${a.L} vs ${b.L}`);
  });
});
