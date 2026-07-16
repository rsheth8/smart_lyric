import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recommendations module exports expected helpers', async () => {
  const mod = await import('../app/recommendations.js');
  assert.equal(typeof mod.fetchChartRecommendations, 'function');
  assert.equal(typeof mod.searchSuggestions, 'function');
  assert.equal(typeof mod.fetchSpotifyRecentlyPlayed, 'function');
  assert.equal(typeof mod.fetchSpotifyNowPlaying, 'function');
});

test('searchSuggestions returns empty for short query', async () => {
  const { searchSuggestions } = await import('../app/recommendations.js');
  assert.deepEqual(await searchSuggestions('a'), []);
  assert.deepEqual(await searchSuggestions(''), []);
});
