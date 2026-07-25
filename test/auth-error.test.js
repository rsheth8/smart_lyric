import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeAuthError } from '../app/streaming/authError.js';

describe('describeAuthError', () => {
  it('returns null when there is no error', () => {
    assert.equal(describeAuthError(null, 'http://127.0.0.1:4321/'), null);
    assert.equal(describeAuthError(undefined, 'http://127.0.0.1:4321/'), null);
    assert.equal(describeAuthError('', 'http://127.0.0.1:4321/'), null);
  });

  it('gives a clear message when the user declines', () => {
    const msg = describeAuthError('access_denied', 'http://127.0.0.1:4321/');
    assert.match(msg, /declined/i);
    assert.match(msg, /Connect Spotify/);
  });

  it('names the exact redirect URI for other errors', () => {
    const msg = describeAuthError('invalid_client', 'http://127.0.0.1:4321/');
    assert.match(msg, /invalid_client/);
    assert.match(msg, /http:\/\/127\.0\.0\.1:4321\//);
    assert.match(msg, /Dashboard/);
  });

  it('falls back gracefully when the redirect URI is unknown', () => {
    const msg = describeAuthError('server_error', '');
    assert.match(msg, /redirect URI/);
  });
});
