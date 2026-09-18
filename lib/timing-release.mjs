import { createHash } from 'node:crypto';
import { validateTimings } from './word-timings.mjs';
import { recordingMatches } from './recording-identity.mjs';
import { measureTiming } from './timing-accuracy.mjs';

export const artifactHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This checks the submitted reference and measurements, not whether a reviewer
// actually listened. Human review remains an explicit operator responsibility.
export function checkTimingRelease(prediction, reference) {
  validateTimings(prediction);
  if (!recordingMatches(prediction.meta.recording, reference.meta?.recording)
    || !Number.isFinite(reference.meta?.duration)
    || Math.abs(prediction.meta.duration - reference.meta.duration) > 0.1) {
    throw new Error('Reference must identify the same recording and audio duration.');
  }
  const review = reference.review;
  if (review?.status !== 'reviewed' || typeof review.reviewer !== 'string' || !review.reviewer.trim()
    || typeof review.secondReviewer !== 'string' || !review.secondReviewer.trim()
    || review.secondReviewer.trim().toLowerCase() === review.reviewer.trim().toLowerCase()) {
    throw new Error('Reference requires two named, distinct reviewers.');
  }
  const words = reference.words;
  if (!Array.isArray(words) || !words.length || words.length > 10000) throw new Error('Reference requires timed words.');
  let previous = -1;
  for (const word of words) {
    if (typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start)
      || !Number.isFinite(word.end) || word.start < 0 || word.start < previous
      || word.end < word.start || word.end > reference.meta.duration) throw new Error('Invalid reference word bounds.');
    previous = word.start;
  }
  const predicted = prediction.timeline.lines.flatMap(line => line.words);
  const metrics = measureTiming(predicted, words);
  const failures = [];
  if (prediction.timeline.estimated) failures.push('estimated_words_remaining');
  if (metrics.matchedWords !== words.length) failures.push('missing_or_changed_words');
  if (metrics.matchedWords !== predicted.length) failures.push('extra_or_changed_words');
  if (metrics.absolute.within100ms < 0.95) failures.push('fewer_than_95_percent_of_onsets_within_100ms');
  if (predicted.some(word => word.end > prediction.meta.duration)) failures.push('words_beyond_recording');
  return { version: 1, checkedAt: new Date().toISOString(), status: failures.length ? 'needs_review' : 'passed',
    artifactSHA256: artifactHash(prediction), referenceSHA256: artifactHash(reference),
    recording: prediction.meta.recording, review, failures, metrics,
    target: { matchedWords: '100%; no extra words', onsetsWithin100ms: 0.95 },
    limitation: 'Measures word starts against the submitted human reference. Word-end accuracy and Apple TV output delay are not certified.' };
}
