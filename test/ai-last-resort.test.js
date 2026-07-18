import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLyrics, fetchCatalogLyrics } from '../app/providers/lyrics/index.js';

describe('AI lyrics only after catalog exhaustion', () => {
  it('fetchCatalogLyrics never returns an AI source', async () => {
    const result = await fetchCatalogLyrics(
      { track: 'Song', lyricsFile: { name: 'x.lrc', text: async () => '[00:01.00]Hi' } },
      { sources: ['local'] }
    );
    assert.equal(result.source, 'local');
    assert.notEqual(result.source, 'ai-transcript');
    assert.notEqual(result.source, 'ai-spotify');
  });

  it('allowTranscript:false skips AI even when an audioFile is attached', async () => {
    const result = await fetchLyrics(
      {
        track: 'DefinitelyMissingTrackXYZ',
        artist: 'Nobody',
        audioFile: { name: 'fake.wav' },
      },
      { sources: ['transcript'], plain: false, allowTranscript: false }
    );
    assert.equal(result, null);
  });

  it('without audioFile, transcript source cannot invent lyrics', async () => {
    const result = await fetchLyrics(
      { track: 'DefinitelyMissingTrackXYZ', artist: 'Nobody' },
      { sources: ['transcript'], plain: false, allowTranscript: true }
    );
    assert.equal(result, null);
  });
});
