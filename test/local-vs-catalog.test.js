import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalogLyrics } from '../app/providers/lyrics/index.js';

// A sidecar the app paired by filename (line-level .lrc, like LRCLIB ships).
const sidecar = (name = 'Adele - Someone Like You.lrc', body = '[00:14.70] I heard that you\'re settled down') => ({
  name,
  text: async () => body,
});

const YRC = { format: 'yrc', text: '[0,100](0,50,0)word', meta: { duration: 285 } };
const LRCLIB_LINE = { format: 'lrc', text: '[00:14.70] line', meta: { duration: 285 } };

let calls;
function mockFetch({ netease = null, musixmatch = null, lrclib = null, fail = false } = {}) {
  calls = { netease: 0, musixmatch: 0, lrclib: 0 };
  global.fetch = async (url) => {
    const u = String(url);
    const reply = (body) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    if (fail) throw new Error('network down');
    if (u.includes('/api/lyrics')) {
      calls.netease++;
      return reply(netease?.format === 'yrc'
        ? { yrc: netease.text, lrc: '', meta: netease.meta }
        : { yrc: '', lrc: netease?.text || '', meta: netease?.meta || null });
    }
    if (u.includes('/api/richsync')) {
      calls.musixmatch++;
      return reply({ richsync: musixmatch?.text || '', meta: musixmatch?.meta || null });
    }
    if (u.includes('lrclib')) {
      calls.lrclib++;
      return reply(lrclib ? [{ syncedLyrics: lrclib.text, duration: lrclib.meta.duration, trackName: 't', artistName: 'a' }] : []);
    }
    return reply({});
  };
}

beforeEach(() => mockFetch());
afterEach(() => { delete global.fetch; });

test('explicit lyrics import is authoritative — catalogs are never consulted', async () => {
  mockFetch({ netease: YRC });
  const res = await fetchCatalogLyrics({
    track: 'Someone Like You', artist: 'Adele', duration: 285,
    lyricsFile: sidecar(), // no lyricsFileAuto → user picked it
  });
  assert.equal(res.source, 'local', 'the file the user chose wins');
  assert.equal(calls.netease, 0, 'no catalog lookup at all');
});

test('auto-paired line-level sidecar yields to word-level catalog timing', async () => {
  mockFetch({ netease: YRC });
  const res = await fetchCatalogLyrics({
    track: 'Someone Like You', artist: 'Adele', duration: 285,
    lyricsFile: sidecar(), lyricsFileAuto: true,
  });
  assert.equal(res.format, 'yrc', 'word-level timing beats the guessed sidecar');
  assert.notEqual(res.source, 'local');
});

test('auto-paired sidecar still wins over a merely line-level catalog hit', async () => {
  mockFetch({ lrclib: LRCLIB_LINE }); // no word-level anywhere
  const res = await fetchCatalogLyrics({
    track: 'Someone Like You', artist: 'Adele', duration: 285,
    lyricsFile: sidecar(), lyricsFileAuto: true,
  });
  assert.equal(res.source, 'local', 'never trade the local file for an equal-quality remote one');
});

test('auto-paired sidecar survives catalogs being unreachable (offline)', async () => {
  mockFetch({ fail: true });
  const res = await fetchCatalogLyrics({
    track: 'Someone Like You', artist: 'Adele', duration: 285,
    lyricsFile: sidecar(), lyricsFileAuto: true,
  });
  assert.equal(res.source, 'local', 'network failure must not lose the local lyrics');
});

test('an auto-paired sidecar that is ALREADY word-level short-circuits', async () => {
  mockFetch({ netease: YRC });
  const res = await fetchCatalogLyrics({
    track: 'Someone Like You', artist: 'Adele', duration: 285,
    lyricsFile: sidecar('Adele - Someone Like You.ass', 'Dialogue: {\\k50}word'),
    lyricsFileAuto: true,
  });
  assert.equal(res.source, 'local', 'nothing to upgrade to — skip the lookup');
  assert.equal(calls.netease, 0);
});
