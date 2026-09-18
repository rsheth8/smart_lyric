import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/lyrics.js';
for (const kind of ['word', 'line', 'missing', 'failure']) {
  test(`lyrics cache policy: ${kind}`, async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async url => {
      if (kind === 'failure') throw new Error('temporary network failure');
      if (String(url).includes('/search/')) return new Response(JSON.stringify({ result: { songs:
        kind === 'missing' ? [] : [{ id: 1, name: 'Song', artists: [{ name: 'Test' }], duration: 30000 }] } }));
      return new Response(JSON.stringify({ lrc: { lyric: '[00:01]Example' },
        yrc: { lyric: kind === 'word' ? '[1000,500](1000,500,0)Example' : '' } }));
    };
    const headers = {};
    try {
      await handler({ query: { artist: 'Test', track: 'Song' } }, {
        setHeader: (key, value) => { headers[key] = value; }, end() {},
      });
      assert.equal(headers['Cache-Control'], kind === 'word' ? 'public, max-age=86400' : 'no-store');
    } finally { globalThis.fetch = previous; }
  });
}
