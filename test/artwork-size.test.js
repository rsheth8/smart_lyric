import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeArtwork } from '../app/art.js';

const RSS_PNG =
  'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/61/49/8d/abc/196874328590.jpg/170x170bb.png';
const SEARCH_JPG =
  'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/9f/13/ca/def/cover.jpg/100x100bb.jpg';

describe('upgradeArtwork', () => {
  test('resizes the chart RSS thumbnail and drops PNG for JPEG', () => {
    // 600px PNG is ~287KB vs ~105KB as JPEG for the same cover, ×12 on the hub.
    assert.equal(
      upgradeArtwork(RSS_PNG),
      'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/61/49/8d/abc/196874328590.jpg/600x600bb.jpg'
    );
  });

  test('resizes the Search API thumbnail', () => {
    assert.equal(
      upgradeArtwork(SEARCH_JPG),
      'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/9f/13/ca/def/cover.jpg/600x600bb.jpg'
    );
  });

  test('honours an explicit size', () => {
    assert.match(upgradeArtwork(RSS_PNG, 300), /\/300x300bb\.jpg$/);
  });

  test('only rewrites the trailing rendition, never the asset path', () => {
    // The path itself contains ".jpg" — a careless replace would corrupt it.
    const out = upgradeArtwork(RSS_PNG);
    assert.ok(out.includes('/196874328590.jpg/'), 'asset path must survive');
    assert.equal(out.match(/\d+x\d+bb/g).length, 1);
  });

  test('leaves non-iTunes URLs alone', () => {
    const spotify = 'https://i.scdn.co/image/ab67616d0000b273abcdef';
    assert.equal(upgradeArtwork(spotify), spotify);
  });

  test('returns an empty string for missing input', () => {
    assert.equal(upgradeArtwork(''), '');
    assert.equal(upgradeArtwork(null), '');
    assert.equal(upgradeArtwork(undefined), '');
  });
});
