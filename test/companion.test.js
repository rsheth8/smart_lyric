import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  parseSong,
  parseName,
  newRoomCode,
  newPeerId,
  relayUrl,
  ROOM_RE,
  PEER_RE,
  NAME_MAX,
  songFinished,
  fairOrder,
} from '../app/companion.js';

describe('companion — room codes', () => {
  it('mints codes the relay accepts, with no ambiguous characters', () => {
    for (let i = 0; i < 300; i++) {
      const code = newRoomCode();
      assert.match(code, ROOM_RE);
      assert.doesNotMatch(code, /[IO01]/);
    }
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', 'ABCDEFG', 'ABCDEFGHJ', 'abcdefgh', 'ABCDEFG1', 'ABCD/../']) {
      assert.doesNotMatch(bad, ROOM_RE);
    }
  });
});

describe('parseSong', () => {
  it('trims, caps and keeps only safe fields', () => {
    const song = parseSong({
      track: '  Boston ',
      artist: 'Stella Lefty',
      duration: 201,
      artwork: 'https://is1-ssl.mzstatic.com/a.jpg',
      evil: '<script>',
    });
    assert.deepEqual(song, {
      track: 'Boston',
      artist: 'Stella Lefty',
      duration: 201,
      artwork: 'https://is1-ssl.mzstatic.com/a.jpg',
    });
    assert.equal(parseSong({ track: 'x'.repeat(999) }).track.length, 200);
  });

  it('rejects a missing track and drops bad duration / non-https art', () => {
    assert.equal(parseSong({ artist: 'A' }), null);
    assert.equal(parseSong({ track: '   ' }), null);
    assert.equal(parseSong('Boston'), null);
    assert.deepEqual(parseSong({ track: 'T', duration: -3, artwork: 'javascript:alert(1)' }), {
      track: 'T',
      artist: '',
    });
    assert.equal(parseSong({ track: 'T', duration: 'NaN' }).duration, undefined);
  });
});

describe('parseCommand', () => {
  it('accepts every valid command, stripping extra fields', () => {
    assert.deepEqual(parseCommand({ type: 'hello', junk: 1 }), { type: 'hello' });
    assert.deepEqual(parseCommand({ type: 'toggle' }), { type: 'toggle' });
    assert.deepEqual(parseCommand({ type: 'change' }), { type: 'change' });
    assert.deepEqual(parseCommand({ type: 'next' }), { type: 'next' });
    assert.deepEqual(parseCommand({ type: 'play', song: { track: 'T' } }), {
      type: 'play',
      song: { track: 'T', artist: '' },
    });
    assert.deepEqual(parseCommand({ type: 'queue', song: { track: 'T', artist: 'A' } }), {
      type: 'queue',
      song: { track: 'T', artist: 'A' },
    });
    assert.deepEqual(parseCommand({ type: 'unqueue', index: 2 }), { type: 'unqueue', index: 2 });
    assert.deepEqual(parseCommand({ type: 'nudge', ms: -25 }), { type: 'nudge', ms: -25 });
    assert.deepEqual(parseCommand({ type: 'feel', sense: 'late' }), { type: 'feel', sense: 'late' });
  });

  it('rejects anything malformed', () => {
    for (const bad of [
      null,
      'toggle',
      {},
      { type: 'rm -rf' },
      { type: 'play' },
      { type: 'queue', song: { artist: 'no track' } },
      { type: 'unqueue', index: -1 },
      { type: 'unqueue', index: 1.5 },
      { type: 'nudge', ms: 50 },
      { type: 'nudge', ms: '25' },
      { type: 'feel', sense: 'meh' },
    ]) {
      assert.equal(parseCommand(bad), null, JSON.stringify(bad));
    }
  });
});

describe('guest rooms', () => {
  it('signs hello / play / queue with a cleaned-up guest name', () => {
    assert.deepEqual(parseCommand({ type: 'hello', by: '  Maya ' }), { type: 'hello', by: 'Maya' });
    assert.deepEqual(parseCommand({ type: 'queue', song: { track: 'T' }, by: 'Sam' }), {
      type: 'queue',
      song: { track: 'T', artist: '' },
      by: 'Sam',
    });
    // Transport commands stay unsigned.
    assert.deepEqual(parseCommand({ type: 'next', by: 'Sam' }), { type: 'next' });
  });

  it('drops empty, non-string and control-character names; caps length', () => {
    assert.deepEqual(parseCommand({ type: 'hello', by: '   ' }), { type: 'hello' });
    assert.deepEqual(parseCommand({ type: 'hello', by: 42 }), { type: 'hello' });
    assert.equal(parseName('Ma\u0000y\u001ba\n'), 'Maya');
    assert.equal(parseName('x'.repeat(99)).length, NAME_MAX);
  });

  it('mints phone ids the relay accepts and puts them in the URL', () => {
    for (let i = 0; i < 100; i++) assert.match(newPeerId(), PEER_RE);
    assert.doesNotMatch('ABCDEFGHJKLM', PEER_RE);
    assert.equal(relayUrl('https://x', 'ABCDEFGH', 'phone', 'abcdefghjkmn'),
      'https://x/api/companion?room=ABCDEFGH&role=phone&peer=abcdefghjkmn');
    assert.equal(relayUrl('https://x', 'ABCDEFGH', 'tv'), 'https://x/api/companion?room=ABCDEFGH&role=tv');
  });
});

describe('songFinished', () => {
  const timeline = { lines: [{ start: 0, end: 10, words: [] }, { start: 10, end: 100, words: [] }], duration: 0 };

  it('is false without lyrics or a clock', () => {
    assert.equal(songFinished({ now: 500, timeline: { lines: [] } }), false);
    assert.equal(songFinished({ now: NaN, timeline }), false);
  });

  it('waits past the last line plus the outro grace', () => {
    assert.equal(songFinished({ now: 105, timeline }), false);
    assert.equal(songFinished({ now: 107, timeline }), true);
  });

  it('respects a duration longer than the lyrics', () => {
    const long = { ...timeline, duration: 180 };
    assert.equal(songFinished({ now: 120, timeline: long }), false);
    assert.equal(songFinished({ now: 187, timeline: long }), true);
  });
});

describe('fairOrder — the rotation', () => {
  it('round-robins the queue between singers', () => {
    const q = [
      { track: 'a', by: 'Alex' },
      { track: 'b', by: 'Alex' },
      { track: 'c', by: 'Alex' },
      { track: 'd', by: 'Sam' },
      { track: 'e', by: 'Jo' },
    ];
    assert.deepEqual(
      fairOrder(q).map((s) => s.track),
      ['a', 'd', 'e', 'b', 'c']
    );
  });

  it("keeps each singer's own songs in the order they queued them", () => {
    const q = [
      { track: 'a1', by: 'Alex' },
      { track: 's1', by: 'Sam' },
      { track: 'a2', by: 'Alex' },
      { track: 's2', by: 'Sam' },
    ];
    const out = fairOrder(q).map((s) => s.track);
    assert.ok(out.indexOf('a1') < out.indexOf('a2'));
    assert.ok(out.indexOf('s1') < out.indexOf('s2'));
  });

  it('is a no-op for one singer, or a queue built on the TV', () => {
    const solo = [{ track: 'a', by: 'Alex' }, { track: 'b', by: 'Alex' }];
    assert.deepEqual(fairOrder(solo).map((s) => s.track), ['a', 'b']);
    const tv = [{ track: 'a' }, { track: 'b' }, { track: 'c' }];
    assert.deepEqual(fairOrder(tv).map((s) => s.track), ['a', 'b', 'c']);
  });

  it('never drops or duplicates a song', () => {
    const q = Array.from({ length: 17 }, (_, i) => ({ track: `t${i}`, by: ['A', 'B', 'C'][i % 3] }));
    const out = fairOrder(q);
    assert.equal(out.length, q.length);
    assert.equal(new Set(out.map((s) => s.track)).size, q.length);
  });

  it('tolerates junk', () => {
    assert.deepEqual(fairOrder(null), []);
    assert.deepEqual(fairOrder([]), []);
    assert.deepEqual(fairOrder([null, { track: 'a' }]).length, 2);
  });
});
