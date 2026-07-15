import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dominantColors, colorDist } from '../app/art.js';

// Build a flat RGBA array from a list of [r,g,b,a?] pixels repeated `n` times.
function pixels(spec) {
  const out = [];
  for (const [color, n] of spec) {
    const [r, g, b, a = 255] = color;
    for (let i = 0; i < n; i++) out.push(r, g, b, a);
  }
  return out;
}

test('colorDist is a plain euclidean distance', () => {
  assert.equal(colorDist([0, 0, 0], [0, 0, 0]), 0);
  assert.ok(Math.abs(colorDist([0, 0, 0], [0, 0, 255]) - 255) < 1e-9);
});

test('returns the most prominent vivid color first', () => {
  const data = pixels([
    [[220, 30, 30], 100], // dominant red
    [[30, 30, 220], 40], // some blue
  ]);
  const [top] = dominantColors(data, { count: 2, step: 1 });
  assert.ok(top[0] > top[1] && top[0] > top[2], 'first color is red-dominant');
});

test('extracts distinct colors, not shades of one', () => {
  const data = pixels([
    [[220, 30, 30], 100],
    [[30, 30, 220], 60],
  ]);
  const colors = dominantColors(data, { count: 2, step: 1 });
  assert.equal(colors.length, 2);
  assert.ok(colorDist(colors[0], colors[1]) > 60, 'the two colors are visually distinct');
});

test('ignores transparent, near-black and near-white pixels', () => {
  const data = pixels([
    [[0, 0, 0, 255], 100], // black — too dark
    [[255, 255, 255, 255], 100], // white — too bright
    [[255, 0, 0, 0], 100], // transparent
  ]);
  assert.deepEqual(dominantColors(data, { count: 3, step: 1 }), []);
});

test('a vivid color still wins over a more frequent muddy one', () => {
  const data = pixels([
    [[120, 118, 115], 200], // lots of muddy grey (low saturation)
    [[230, 40, 160], 90], // vivid magenta
  ]);
  const [top] = dominantColors(data, { count: 1, step: 1 });
  // Saturation weighting should surface the magenta despite lower count.
  assert.ok(top[0] > 150 && top[2] > 100 && top[1] < top[0], 'magenta surfaced');
});

test('never returns more colors than requested', () => {
  const data = pixels([
    [[220, 30, 30], 50],
    [[30, 220, 30], 50],
    [[30, 30, 220], 50],
    [[220, 220, 30], 50],
  ]);
  assert.ok(dominantColors(data, { count: 2, step: 1 }).length <= 2);
});
