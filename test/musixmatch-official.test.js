import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMusixmatchRichsync, officialApiKey } from '../lib/musixmatch.mjs';

const BODY = JSON.stringify([{ ts: 1, te: 2, x: 'hi', l: [{ c: 'hi', o: 0 }] }]);

function ok(body) {
  return {
    ok: true,
    json: async () => ({ message: { header: { status_code: 200 }, body } }),
    headers: { get: () => null },
  };
}

test('officialApiKey reads only a trimmed MUSIXMATCH_API_KEY', () => {
  assert.equal(officialApiKey({}), '');
  assert.equal(officialApiKey({ MUSIXMATCH_API_KEY: '  abc  ' }), 'abc');
});

test('official key matches by ISRC and never calls the desktop token host', async () => {
  const urls = [];
  const result = await fetchMusixmatchRichsync(
    { artist: 'Artist', track: 'Song', isrc: 'usabc2600001' },
    {
      env: { MUSIXMATCH_API_KEY: 'test-key' },
      fetcher: async url => {
        urls.push(String(url));
        assert.match(String(url), /api\.musixmatch\.com/);
        assert.match(String(url), /track_isrc=USABC2600001/);
        return ok({ richsync: { richsync_body: BODY, track_name: 'Song', artist_name: 'Artist', track_length: 30 } });
      },
    },
  );
  assert.equal(result.licensed, true);
  assert.equal(result.cacheable, false);
  assert.equal(result.richsync, BODY);
  assert.equal(result.meta.trackName, 'Song');
  assert.ok(urls.every(url => !url.includes('apic-desktop')));
});

test('official key tries Spotify and Apple Music IDs before a title matcher', async () => {
  const urls = [];
  await fetchMusixmatchRichsync(
    { artist: 'Artist', track: 'Song', spotifyID: 'sp1', appleMusicID: 'am1' },
    {
      env: { MUSIXMATCH_API_KEY: 'test-key' },
      fetcher: async url => {
        urls.push(String(url));
        if (String(url).includes('track_spotify_id=sp1')) return { ok: true, json: async () => ({ message: { header: { status_code: 404 } } }), headers: { get: () => null } };
        return ok({ richsync: { richsync_body: BODY, track_name: 'Song', artist_name: 'Artist' } });
      },
    },
  );
  assert.match(urls[0], /track_spotify_id=sp1/);
  assert.match(urls[1], /track_itunes_id=am1/);
});

test('official ISRC hits keep the requested title when Musixmatch omits names', async () => {
  const result = await fetchMusixmatchRichsync(
    { artist: 'Artist', track: 'Song', isrc: 'USABC2600001' },
    {
      env: { MUSIXMATCH_API_KEY: 'test-key' },
      fetcher: async () => ok({ richsync: { richsync_body: BODY } }),
    },
  );
  assert.equal(result.meta.trackName, 'Song');
  assert.equal(result.meta.artistName, 'Artist');
});

test('official key does not fall back to the unofficial desktop token', async () => {
  const result = await fetchMusixmatchRichsync(
    { artist: 'Artist', track: 'Song' },
    {
      env: { MUSIXMATCH_API_KEY: 'test-key' },
      fetcher: async url => {
        assert.ok(!String(url).includes('apic-desktop'));
        return { ok: true, json: async () => ({ message: { header: { status_code: 404 } } }), headers: { get: () => null } };
      },
    },
  );
  assert.equal(result, null);
});
