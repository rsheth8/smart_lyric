import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchNeteaseLyrics, searchTitle } from '../lib/netease.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const song = (id, name, artists, seconds) => ({
  id, name, artists: artists.map(name => ({ name })), duration: seconds * 1000,
  album: { name: 'Test album' },
});
function fixture(songs, lyricsById) {
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(input); calls.push(url);
    return { ok: true, json: async () => url.pathname.includes('/search/')
      ? { result: { songs } }
      : lyricsById ? lyricsById[url.searchParams.get('id')] ?? {} : { yrc: { lyric: '[1000,500](1000,500,0)Test' } } };
  };
  return calls;
}
describe('NetEase recording search', () => {
  it('removes guest credits while retaining recording variants', () => {
    assert.equal(searchTitle('MUTT (feat. Chris Brown) [CB REMIX]'), 'MUTT [CB REMIX]');
    assert.equal(searchTitle('Song (Live) (feat. Guest)'), 'Song (Live)');
    assert.equal(searchTitle('Song - Single Version'), 'Song - Single Version');
    assert.equal(searchTitle('Song feat. Guest'), 'Song');
    assert.equal(searchTitle('FOREVER (with 6LACK)'), 'FOREVER');
    assert.equal(searchTitle('Dancing with a Stranger'), 'Dancing with a Stranger');
  });
  it('finds a collaboration using its title and lead artist', async () => {
    const calls = fixture([song(1, 'No Guidance', ['Chris Brown', 'Drake'], 260.645)]);
    const result = await fetchNeteaseLyrics({
      artist: 'Chris Brown, Drake', track: 'No Guidance (feat. Drake)', duration: 260,
    });
    assert.equal(calls[0].searchParams.get('s'), 'No Guidance Chris Brown');
    assert.equal(result.meta.neteaseId, 1);
    assert.ok(result.yrc);
  });
  it('rejects unrelated artists even when their title matches exactly', async () => {
    const calls = fixture([song(2, 'No Guidance (feat. Drake)', ['Unrelated Artist'], 260)]);
    assert.equal(await fetchNeteaseLyrics({
      artist: 'Chris Brown, Drake', track: 'No Guidance (feat. Drake)', duration: 260,
    }), null);
    assert.equal(calls.length, 1, 'do not fetch lyrics for a rejected recording');
  });
  it('selects the requested artist ahead of another same-titled song', async () => {
    fixture([song(2, 'Wild Side', ['Another Artist'], 209),
      song(3, 'Wild Side', ['Normani', 'Cardi B'], 209.536)]);
    const result = await fetchNeteaseLyrics({
      artist: 'Normani, Cardi B', track: 'Wild Side (feat. Cardi B)', duration: 209,
    });
    assert.equal(result.meta.neteaseId, 3);
  });
  it('uses duration to choose a take and rejects gross mismatches', async () => {
    fixture([song(1, 'Test', ['Artist'], 180), song(2, 'Test', ['Artist'], 206),
      song(3, 'Test', ['Artist'], 200.4)]);
    assert.equal((await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200})).meta.neteaseId,3);
    fixture([song(4, 'Test', ['Artist'], 250)]);
    assert.equal(await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200}),null);
  });
  it('does not treat missing artist credits as a match', async () => {
    fixture([song(1,'Test',[''],200)]);
    assert.equal(await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200}),null);
  });
  it('retains the existing single-artist query', async () => {
    const calls=fixture([song(1,'Sure Thing',['Miguel'],195)]);
    assert.ok(await fetchNeteaseLyrics({artist:'Miguel',track:'Sure Thing',duration:195}));
    assert.equal(calls[0].searchParams.get('s'),'Sure Thing Miguel');
  });
  it('finds word timing on an equivalent album entry when the single has only lines', async () => {
    const calls=fixture([song(1,'FOREVER',['Jessie Reyez','6LACK'],223.157),
      song(2,'FOREVER',['Jessie Reyez','6LACK'],223.157)], {
      1:{lrc:{lyric:'[00:01.00]Test'}},2:{yrc:{lyric:'[1000,500](1000,500,0)Test'}}
    });
    const result=await fetchNeteaseLyrics({artist:'Jessie Reyez, 6LACK',track:'FOREVER (with 6LACK)',duration:223});
    assert.equal(result.meta.neteaseId,2);
    assert.equal(calls.length,3);
  });
  it('does not borrow word timing from another edit or guest lineup', async () => {
    const calls=fixture([song(1,'Test',['Artist'],200),song(2,'Test (Live)',['Artist'],200),
      song(3,'Test',['Artist','Guest'],200),song(4,'Test',['Artist'],210)], {
      1:{lrc:{lyric:'[00:01.00]Test'}},2:{yrc:{lyric:'wrong'}},3:{yrc:{lyric:'wrong'}},4:{yrc:{lyric:'wrong'}}
    });
    const result=await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200});
    assert.equal(result.meta.neteaseId,1);
    assert.equal(result.yrc,'');
    assert.equal(calls.length,2);
  });
  it('bounds lyric requests to three candidate entries', async () => {
    const calls=fixture(Array.from({length:8},(_,i)=>song(i+1,'Test',['Artist'],200)));
    await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200});
    assert.equal(calls.length,4,'one search plus at most three lyric requests');
  });
  it('retains available lyrics when an alternate entry fails', async () => {
    fixture([song(1,'Test',['Artist'],200),song(2,'Test',['Artist'],200)],{
      1:{lrc:{lyric:'[00:01.00]Test'}}
    });
    const respondingFetch=globalThis.fetch;
    globalThis.fetch=async url=>{
      if(new URL(url).searchParams.get('id')==='2')throw new Error('alternate timed out');
      return respondingFetch(url);
    };
    const result=await fetchNeteaseLyrics({artist:'Artist',track:'Test',duration:200});
    assert.equal(result.meta.neteaseId,1);
    assert.ok(result.lrc);
  });
});
