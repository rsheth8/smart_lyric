import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle,
  cleanTrackTitle,
  primaryArtist,
  titleScore,
  pickBestMatch,
} from '../app/lyrics.js';

describe('normalizeTitle', () => {
  it('expands em → them', () => {
    assert.equal(normalizeTitle('Make em know'), 'Make them know');
  });

  it('collapses extra whitespace', () => {
    assert.equal(normalizeTitle('  Make   em   know  '), 'Make them know');
  });
});

describe('cleanTrackTitle', () => {
  it('strips remaster / feat noise', () => {
    assert.equal(cleanTrackTitle('Creep (Remastered)'), 'Creep');
    assert.equal(cleanTrackTitle('God\'s Plan (feat. Someone)'), 'God\'s Plan');
    assert.equal(cleanTrackTitle('Song - Remastered 2011'), 'Song');
  });
});

describe('primaryArtist', () => {
  it('keeps the first credited artist', () => {
    assert.equal(primaryArtist('The Weeknd, Ariana Grande'), 'The Weeknd');
    assert.equal(primaryArtist('Drake feat. Rihanna'), 'Drake');
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

  it('matches using the primary artist from a multi-artist string', () => {
    const hit = pickBestMatch(list, { artist: 'Drake, Future', track: 'Make Them Know' });
    assert.equal(hit.trackName, 'Make Them Know');
  });

  it('returns null when nothing is close enough', () => {
    assert.equal(pickBestMatch(list, { artist: 'Drake', track: 'Hotline Bling' }), null);
  });

  it('uses duration to pick the right take among same-titled candidates', () => {
    const takes = [
      { trackName: 'Passionfruit', artistName: 'Drake', duration: 338, syncedLyrics: '[00:00.00]live' },
      { trackName: 'Passionfruit', artistName: 'Drake', duration: 298, syncedLyrics: '[00:00.00]album' },
    ];
    const hit = pickBestMatch(takes, { artist: 'Drake', track: 'Passionfruit', duration: 299 });
    assert.equal(hit.syncedLyrics, '[00:00.00]album');
  });
});
