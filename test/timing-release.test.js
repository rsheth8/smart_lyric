import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTimingRelease } from '../lib/timing-release.mjs';
const fixture = () => {
  const meta = { artist: 'Test', track: 'Song', duration: 30, recording: { spotifyID: 'a', explicit: true } };
  const words = Array.from({ length: 20 }, (_, i) => ({ text: `word${i}`, start: i + 1, end: i + 1.5, score: 1 }));
  return { prediction: { version: 1, meta, quality: { anchoredFraction: 1 },
    timeline: { source: 'aligned', estimated: false, lines: [{ start: 1, end: 21, uncertain: false, words }] } },
    reference: { meta: structuredClone(meta), review: { status: 'reviewed', reviewer: 'Reviewer A', secondReviewer: 'Reviewer B' }, words: structuredClone(words) } };
};
test('complete reviewed word onsets pass and retain provenance hashes', () => {
  const { prediction, reference } = fixture();
  const report = checkTimingRelease(prediction, reference);
  assert.equal(report.status, 'passed');
  assert.equal(report.artifactSHA256.length, 64);
  assert.equal(report.metrics.matchedFraction, 1);
});
test('constant offset cannot hide absolute timing failure', () => {
  const { prediction, reference } = fixture();
  reference.words.forEach(word => { word.start += 0.5; word.end += 0.5; });
  const report = checkTimingRelease(prediction, reference);
  assert.equal(report.status, 'needs_review');
  assert.equal(report.metrics.afterConstantOffset.within100ms, 1);
});
test('missing and extra words and remaining estimates each fail publication', () => {
  for (const change of ['missing', 'extra', 'estimated']) {
    const { prediction, reference } = fixture();
    if (change === 'missing') prediction.timeline.lines[0].words.pop();
    if (change === 'extra') reference.words.pop();
    if (change === 'estimated') prediction.timeline.estimated = true;
    assert.equal(checkTimingRelease(prediction, reference).status, 'needs_review');
  }
});
test('wrong editions, unmatched audio durations and unreviewed references are rejected', () => {
  for (const change of ['edition', 'duration', 'review']) {
    const { prediction, reference } = fixture();
    if (change === 'edition') reference.meta.recording.spotifyID = 'b';
    if (change === 'duration') reference.meta.duration = 31;
    if (change === 'review') reference.review.secondReviewer = 'Reviewer A';
    assert.throws(() => checkTimingRelease(prediction, reference));
  }
});
