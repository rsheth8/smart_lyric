import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, titleScore, pickBestMatch } from '../app/lyrics.js';

describe('normalizeTitle', () => {
  it('expands em → them', () => {
    assert.equal(normalizeTitle('Make em know'), 'Make them know');
  });

  it('collapses extra whitespace', () => {
    assert.equal(normalizeTitle('  Make   em   know  '), 'Make them know');
  });
});

describe('titleScore', () => {
  it('scores an exact match as 1', () => {
    assert.equal(titleScore('Make em know', 'Make Them Know'), 1);
  });

  it('scores partial overlap lower than exact', () => {
    assert.ok(titleScore('Make em know', 'Make Me Proud') < titleScore('Make em know', 'Make Them Know'));
  });
});

describe('pickBestMatch', () => {
  const list = [
    { trackName: 'Make Me Proud', artistName: 'Drake', syncedLyrics: '[00:00.00]x' },
    { trackName: 'Make Them Know', artistName: 'Drake', syncedLyrics: '[00:00.00]y' },
  ];

  it('picks the closest title for the user query', () => {
    const hit = pickBestMatch(list, { artist: 'Drake', track: 'Make em know' });
    assert.equal(hit.trackName, 'Make Them Know');
  });

  it('filters by artist when provided', () => {
    const mixed = [
      ...list,
      { trackName: 'Make Them Know', artistName: 'Someone Else', syncedLyrics: '[00:00.00]z' },
    ];
    const hit = pickBestMatch(mixed, { artist: 'Drake', track: 'Make Them Know' });
    assert.equal(hit.artistName, 'Drake');
  });

  it('returns null when nothing is close enough', () => {
    assert.equal(pickBestMatch(list, { artist: 'Drake', track: 'Hotline Bling' }), null);
  });
});
