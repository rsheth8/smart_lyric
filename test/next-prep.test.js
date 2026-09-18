import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sameTrack,
  trackIdentity,
  ensureNextPrep,
  takeReadyPrep,
  clearNextPrep,
  peekNextPrep,
} from '../app/next-prep.js';

beforeEach(() => clearNextPrep());

const stubs = (result) => ({
  fetchCatalog: async () => result,
  hydrate: async () => ({ imported: false }),
  resolve: () => ({ offset: 0.12, source: 'device', strong: true }),
  peekCache: () => null,
});

test('sameTrack matches on Spotify id even when titles differ', () => {
  assert.equal(
    sameTrack({ id: 'abc', title: 'A' }, { id: 'abc', track: 'A (Remastered)' }),
    true
  );
  assert.equal(sameTrack({ id: 'a' }, { id: 'b' }), false);
});

test('sameTrack falls back to artist::title', () => {
  assert.equal(
    sameTrack({ artist: 'Adele', title: 'Hello' }, { artist: 'Adele', track: 'Hello' }),
    true
  );
  assert.equal(trackIdentity({ id: 'x' }), 'id:x');
});

test('ensureNextPrep fetches catalog once per upcoming track', async () => {
  let calls = 0;
  const deps = {
    ...stubs({ lrc: '[00:01.00] hello', format: 'lrc', source: 'lrclib' }),
    fetchCatalog: async () => {
      calls += 1;
      return { lrc: '[00:01.00] hello', format: 'lrc', source: 'lrclib' };
    },
  };
  const p1 = ensureNextPrep({ id: 'n1', artist: 'A', title: 'Next', duration: 200 }, deps);
  const p2 = ensureNextPrep({ id: 'n1', artist: 'A', title: 'Next', duration: 200 }, deps);
  assert.equal(p1, p2, 'same promise while in flight / ready');
  await p1;
  assert.equal(calls, 1);
  assert.equal(peekNextPrep()?.status, 'ready');
  assert.equal(peekNextPrep()?.offset?.offset, 0.12);
});

test('takeReadyPrep claims the buffer for the matching track', async () => {
  await ensureNextPrep(
    { id: 'n2', artist: 'B', title: 'Soon', duration: 180 },
    stubs({ lrc: '[00:01.00] hi', format: 'lrc', source: 'lrclib' })
  );
  const taken = await takeReadyPrep({ id: 'n2', title: 'Soon', artist: 'B' });
  assert.ok(taken?.result?.lrc);
  assert.equal(peekNextPrep(), null, 'buffer cleared after take');
  const again = await takeReadyPrep({ id: 'n2', title: 'Soon', artist: 'B' });
  assert.equal(again, null);
});

test('takeReadyPrep ignores a prep for a different track', async () => {
  await ensureNextPrep(
    { id: 'n3', artist: 'C', title: 'Other', duration: 180 },
    stubs({ lrc: '[00:01.00] x', format: 'lrc', source: 'lrclib' })
  );
  const taken = await takeReadyPrep({ id: 'n4', title: 'Different', artist: 'D' });
  assert.equal(taken, null);
  assert.ok(peekNextPrep(), 'unrelated prep stays');
});

test('skipIf refuses to prep the song that is already current', async () => {
  const cur = { id: 'cur', artist: 'X', title: 'Now' };
  let calls = 0;
  const out = ensureNextPrep(cur, {
    skipIf: cur,
    fetchCatalog: async () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(out, null);
  assert.equal(calls, 0);
});
