import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventField, waitBucket, sungBucket } from '../app/analytics.js';

test('eventField accepts allowlisted events and builds a stable field', () => {
  assert.equal(eventField('{"name":"party_on"}'), 'party_on');
  assert.equal(
    eventField({ name: 'song_ready', data: { surface: 'tv', wait: '2-10s' } }),
    'song_ready|surface=tv|wait=2-10s'
  );
});

test('eventField rejects anything that could mint new counter fields', () => {
  assert.equal(eventField('not json'), null);
  assert.equal(eventField({ name: 'constructor' }), null);
  assert.equal(eventField({ name: 'hacked' }), null);
  assert.equal(eventField({ name: 'song_ready', data: { wait: '999s' } }), null);
});

test('buckets', () => {
  assert.equal(waitBucket(500), '<2s');
  assert.equal(waitBucket(45000), '>30s');
  assert.equal(sungBucket(0.1), '<25%');
  assert.equal(sungBucket(0.9), '>75%');
});
