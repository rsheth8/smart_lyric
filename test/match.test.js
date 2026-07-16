import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  durationScore,
  durationMismatch,
  candidateScore,
  preferResult,
} from '../app/providers/lyrics/match.js';

describe('durationScore', () => {
  it('is 1 when lengths agree within tolerance', () => {
    assert.equal(durationScore(200, 201), 1);
    assert.equal(durationScore(200, 202), 1);
  });

  it('is 0 when far apart', () => {
    assert.equal(durationScore(200, 220), 0);
  });

  it('decays between near and far', () => {
    const s = durationScore(200, 207); // 7s off
    assert.ok(s > 0 && s < 1);
  });

  it('is null when either length is unknown', () => {
    assert.equal(durationScore(0, 200), null);
    assert.equal(durationScore(200, undefined), null);
    assert.equal(durationScore(200, 0), null);
  });
});

describe('durationMismatch', () => {
  it('flags grossly different lengths', () => {
    assert.equal(durationMismatch(200, 240), true); // 40s off → wrong take
  });

  it('does not flag close or unknown lengths', () => {
    assert.equal(durationMismatch(200, 205), false);
    assert.equal(durationMismatch(200, undefined), false);
    assert.equal(durationMismatch(undefined, 200), false);
  });
});

describe('candidateScore', () => {
  it('breaks a title tie toward the closer duration', () => {
    const album = candidateScore({ titleScore: 1, targetDuration: 200, candidateDuration: 201 });
    const live = candidateScore({ titleScore: 1, targetDuration: 200, candidateDuration: 260 });
    assert.ok(album > live);
  });

  it('leaves the title score untouched when duration is unknown', () => {
    assert.equal(candidateScore({ titleScore: 0.85, targetDuration: undefined }), 0.85);
  });

  it('lets a perfect-length near-title beat an exact title with a wrong length', () => {
    const wrongLen = candidateScore({ titleScore: 1, targetDuration: 200, candidateDuration: 260 });
    const goodLen = candidateScore({ titleScore: 0.85, targetDuration: 200, candidateDuration: 200 });
    assert.ok(goodLen > wrongLen);
  });
});

describe('preferResult', () => {
  const yrc = { format: 'yrc', meta: { duration: 260 } }; // wrong take (live), word-level
  const lrc = { format: 'lrc', meta: { duration: 200 } }; // correct album cut, line-level

  it('keeps preference order when no target duration is known', () => {
    assert.equal(preferResult([yrc, lrc]), yrc);
  });

  it('keeps preference order when durations are plausible', () => {
    const okYrc = { format: 'yrc', meta: { duration: 201 } };
    assert.equal(preferResult([okYrc, lrc], 200), okYrc);
  });

  it('skips a word-level hit whose length grossly mismatches the target', () => {
    assert.equal(preferResult([yrc, lrc], 200), lrc);
  });

  it('falls back to preference order when every candidate mismatches', () => {
    const alsoWrong = { format: 'lrc', meta: { duration: 300 } };
    assert.equal(preferResult([yrc, alsoWrong], 200), yrc);
  });

  it('keeps an unknown-duration word-level hit (conservative)', () => {
    const noDur = { format: 'yrc', meta: {} };
    assert.equal(preferResult([noDur, lrc], 200), noDur);
  });

  it('returns null when there are no results', () => {
    assert.equal(preferResult([null, undefined], 200), null);
  });
});
