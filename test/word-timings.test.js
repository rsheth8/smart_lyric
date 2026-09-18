import test from 'node:test';
import assert from 'node:assert/strict';
import { timingKey, validateTimings, readTimings, writeTimings } from '../lib/word-timings.mjs';
import { recordingMatches } from '../lib/recording-identity.mjs';
const value = () => ({ version: 1, meta: { artist: 'Test', track: 'Song', duration: 30 },
  timeline: { source: 'aligned', estimated: false, duration: 30,
    lines: [{ start: 1, end: 3, uncertain: false, words: [{ text: 'Hello', start: 1, end: 2, score: 0.9 }] }] },
  quality: { anchoredFraction: 1 } });
const env = { SUPABASE_URL: 'https://store.test', SUPABASE_SERVICE_ROLE_KEY: 'test-only' };
test('prepared timings reject backwards words and missing provenance', () => {
  assert.equal(validateTimings(value()).timeline.source, 'aligned');
  const bad = value(); bad.timeline.lines[0].words[0].end = 0;
  assert.throws(() => validateTimings(bad));
  const missing = value(); delete missing.quality;
  assert.throws(() => validateTimings(missing));
});
test('normalization preserves non-Latin titles', () => {
  assert.equal(timingKey('Brent Faiyaz', 'other side.'), timingKey('brent faiyaz', 'Other Side'));
  assert.notEqual(timingKey('歌手', '歌一'), timingKey('歌手', '歌二'));
});
test('lookup rejects another recording even if storage returns it', async () => {
  const wrong = value(); wrong.meta.duration = 60;
  const result = await readTimings({ artist: 'Test', track: 'Song', duration: 30 }, {
    env, fetcher: async () => new Response(JSON.stringify([{ value: wrong }, { value: value() }])) });
  assert.equal(result.meta.duration, 30);
});
test('publishing sends timings and credentials only to configured storage', async () => {
  await writeTimings(value(), { env, fetcher: async (url, request) => {
    assert.equal(url, 'https://store.test/rest/v1/word_timings');
    const row = JSON.parse(request.body);
    assert.equal(row.duration, 30);
    assert.equal(row.value.timeline.source, 'aligned');
    assert.equal(request.method, 'POST');
    return new Response(null, { status: 201 });
  }});
});

test('same title and duration cannot substitute a different recording or legacy artifact', async () => {
  const target = { spotifyID: 'recording-a', isrc: 'USABC2600001', explicit: true };
  const exact = value(); exact.meta.recording = target;
  const wrong = value(); wrong.meta.recording = { ...target, spotifyID: 'recording-b' };
  const clean = value(); clean.meta.recording = { ...target, explicit: false };
  const lookup = rows => readTimings({ artist: 'Test', track: 'Song', duration: 30, recording: target }, {
    env, fetcher: async () => new Response(JSON.stringify(rows.map(value => ({ value })))) });
  assert.equal(await lookup([wrong, clean, value()]), null);
  assert.deepEqual((await lookup([wrong, exact])).meta.recording, target);
  assert.equal(recordingMatches(target, { isrc: target.isrc, explicit: true }), true);
  assert.equal(recordingMatches(target, { isrc: target.isrc }), false);
  assert.equal(recordingMatches(target, { ...target, isrc: 'USABC2600002' }), false);
});

test('same-length editions are stored under distinct keys and uncertain output stays estimated', async () => {
  const rows = [];
  for (const spotifyID of ['recording-a', 'recording-b']) {
    const artifact = value(); artifact.meta.recording = { spotifyID };
    await writeTimings(artifact, { env, fetcher: async (_, request) => {
      rows.push(JSON.parse(request.body)); return new Response(null, { status: 201 });
    }});
  }
  assert.notEqual(rows[0].id, rows[1].id);
  assert.notEqual(rows[0].track_key, rows[1].track_key);
  const uncertain = value(); uncertain.timeline.lines[0].uncertain = true;
  assert.throws(() => validateTimings(uncertain), /Uncertain/);
  uncertain.timeline.estimated = true;
  assert.doesNotThrow(() => validateTimings(uncertain));
});

test('reviewed recordings with both service IDs publish searchable identity aliases', async () => {
  const artifact = value(); artifact.meta.recording = {
    spotifyID: 'a', appleMusicID: '123', isrc: 'USABC2600001', explicit: true };
  const rows = [];
  await writeTimings(artifact, { env, fetcher: async (_, request) => {
    rows.push(...JSON.parse(request.body)); return new Response(null, { status: 201 });
  }});
  assert.equal(new Set(rows.map(row => row.track_key)).size, 3);
  for (const recording of [{ spotifyID: 'a' }, { appleMusicID: '123' }, { isrc: 'USABC2600001', explicit: true }]) {
    const found = await readTimings({ artist: 'Test', track: 'Song', duration: 30, recording }, {
      env, fetcher: async url => {
        const key = new URL(url).searchParams.get('track_key').slice(3);
        return new Response(JSON.stringify(rows.filter(row => row.track_key === key)));
      } });
    assert.equal(found.meta.recording.spotifyID, 'a');
  }
});
