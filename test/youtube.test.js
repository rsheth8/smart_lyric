import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubeId,
  parseYouTubeTitle,
  guessMetaFromFilename,
  youtubePlayerErrorMessage,
} from '../app/youtube.js';

describe('parseYouTubeId', () => {
  it('accepts bare ids', () => {
    assert.equal(parseYouTubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('parses watch, short, embed, and youtu.be urls', () => {
    assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  });

  it('rejects junk', () => {
    assert.equal(parseYouTubeId(''), null);
    assert.equal(parseYouTubeId('not-a-url'), null);
    assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  });
});

describe('parseYouTubeTitle / filename guess', () => {
  it('splits Artist - Track and strips official MV suffixes', () => {
    assert.deepEqual(parseYouTubeTitle('Adele - Someone Like You (Official Music Video)'), {
      artist: 'Adele',
      track: 'Someone Like You',
    });
    assert.deepEqual(guessMetaFromFilename('Coldplay - Yellow.mp4'), {
      artist: 'Coldplay',
      track: 'Yellow',
    });
  });
});

describe('youtubePlayerErrorMessage', () => {
  it('points embed blocks at local files', () => {
    assert.match(youtubePlayerErrorMessage(150), /local music-video/i);
  });
});
