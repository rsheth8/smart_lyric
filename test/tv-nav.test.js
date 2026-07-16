import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from '../app/tv-nav.js';

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

// A 2x2 grid plus a wide search bar above:
//   [search........................]
//   [a]  [b]
//   [c]  [d]
const search = rect(0, 0, 300, 40);
const a = rect(0, 60, 140, 60);
const b = rect(160, 60, 140, 60);
const c = rect(0, 140, 140, 60);
const d = rect(160, 140, 140, 60);
const grid = [search, a, b, c, d];

describe('pickNext', () => {
  it('moves right/left along a row', () => {
    assert.equal(pickNext(grid, 1, 'right'), 2); // a → b
    assert.equal(pickNext(grid, 2, 'left'), 1); // b → a
  });

  it('moves down/up along a column', () => {
    assert.equal(pickNext(grid, 1, 'down'), 3); // a → c
    assert.equal(pickNext(grid, 3, 'up'), 1); // c → a
  });

  it('returns -1 at the edge of the layout', () => {
    assert.equal(pickNext(grid, 1, 'left'), -1); // a is leftmost
    assert.equal(pickNext(grid, 3, 'down'), -1); // c is on the bottom row
    assert.equal(pickNext(grid, 0, 'up'), -1); // search is on top
  });

  it('prefers the aligned candidate over a nearer diagonal one', () => {
    // From b going down: d overlaps b's column; c is closer to nothing — d wins.
    assert.equal(pickNext(grid, 2, 'down'), 4);
  });

  it('up from a grid item reaches the wide bar spanning both columns', () => {
    assert.equal(pickNext(grid, 2, 'up'), 0); // b → search
  });

  it('handles a missing from-rect', () => {
    assert.equal(pickNext(grid, 99, 'down'), -1);
  });
});
