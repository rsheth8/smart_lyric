import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../app/analytics.js';
import {
  GRADE_NAMES,
  ScoreKeeper,
  pitchAccuracy,
  combine,
  gradeFor,
  SING_LEVEL,
  MIN_FRAMES,
  TOLERANCE_CENTS,
  CUTOFF_CENTS,
} from '../app/score.js';

test('pitchAccuracy is flat inside the tolerance and zero past the cutoff', () => {
  assert.equal(pitchAccuracy(0), 1);
  assert.equal(pitchAccuracy(TOLERANCE_CENTS), 1);
  assert.equal(pitchAccuracy(-TOLERANCE_CENTS), 1);
  assert.equal(pitchAccuracy(CUTOFF_CENTS), 0);
  assert.equal(pitchAccuracy(-999), 0);
  assert.ok(pitchAccuracy(125) > 0 && pitchAccuracy(125) < 1);
  assert.equal(pitchAccuracy(null), null);
  assert.equal(pitchAccuracy(NaN), null);
});

test('combine falls back to coverage alone with no pitch reference', () => {
  assert.equal(combine(1, null), 100);
  assert.equal(combine(0.5, null), 50);
  // Perfect coverage but flat singing still loses the pitch share.
  assert.equal(combine(1, 0), 60);
  assert.equal(combine(1, 1), 100);
});

test('combine clamps nonsense inputs', () => {
  assert.equal(combine(2, 2), 100);
  assert.equal(combine(-1, -1), 0);
});

test('gradeFor covers every band', () => {
  assert.equal(gradeFor(100), 'Superstar');
  assert.equal(gradeFor(90), 'Superstar');
  assert.equal(gradeFor(85), 'Headliner');
  assert.equal(gradeFor(70), 'Encore');
  assert.equal(gradeFor(60), 'Warmed up');
  assert.equal(gradeFor(0), 'Keep going');
});

test('no score until someone actually sang', () => {
  const k = new ScoreKeeper();
  assert.equal(k.result(), null);
  for (let i = 0; i < MIN_FRAMES - 1; i++) k.sample({ expected: true, level: 1 });
  assert.equal(k.result(), null);
  k.sample({ expected: true, level: 1 });
  assert.ok(k.result());
});

test('instrumental breaks are not held against the singer', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 200; i++) k.sample({ expected: false, level: 0 });
  assert.equal(k.result(), null, 'silence over an intro must not create a score');
  assert.equal(k.expectedFrames, 0);
});

test('singing every word on pitch scores 100', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 100; i++) k.sample({ expected: true, level: 0.3, cents: 10 });
  const r = k.result();
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'Superstar');
  assert.equal(r.coverage, 1);
  assert.equal(r.pitch, 1);
  assert.equal(r.scored, true);
});

test('never opening your mouth scores 0', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 100; i++) k.sample({ expected: true, level: 0 });
  const r = k.result();
  assert.equal(r.score, 0);
  assert.equal(r.coverage, 0);
  assert.equal(r.pitch, null);
  assert.equal(r.scored, false);
});

test('singing the words off-key beats not singing at all', () => {
  const flat = new ScoreKeeper();
  const silent = new ScoreKeeper();
  for (let i = 0; i < 100; i++) {
    flat.sample({ expected: true, level: 0.3, cents: 400 });
    silent.sample({ expected: true, level: 0 });
  }
  assert.ok(flat.result().score > silent.result().score);
  assert.equal(flat.result().score, 60);
});

test('the sing gate ignores room tone just under the threshold', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 100; i++) k.sample({ expected: true, level: SING_LEVEL - 0.001 });
  assert.equal(k.result().coverage, 0);
});

test('best streak survives a dropped phrase', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 30; i++) k.sample({ expected: true, level: 0.3 });
  for (let i = 0; i < 5; i++) k.sample({ expected: true, level: 0 });
  for (let i = 0; i < 10; i++) k.sample({ expected: true, level: 0.3 });
  assert.equal(k.bestStreak, 30);
  assert.equal(k.streak, 10);
});

test('a break resets the streak without scoring against you', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 50; i++) k.sample({ expected: true, level: 0.3 });
  k.sample({ expected: false });
  assert.equal(k.streak, 0);
  assert.equal(k.bestStreak, 50);
  assert.equal(k.expectedFrames, 50);
});

test('pitch only counts on frames where someone was singing', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 50; i++) k.sample({ expected: true, level: 0.3, cents: 0 });
  for (let i = 0; i < 50; i++) k.sample({ expected: true, level: 0, cents: 400 });
  const r = k.result();
  assert.equal(r.pitch, 1, 'silent frames must not drag the pitch average');
  assert.equal(r.coverage, 0.5);
});

test('reset clears everything', () => {
  const k = new ScoreKeeper();
  for (let i = 0; i < 100; i++) k.sample({ expected: true, level: 0.3, cents: 0 });
  assert.ok(k.result());
  k.reset();
  assert.equal(k.result(), null);
  assert.equal(k.bestStreak, 0);
});

test('sample tolerates an empty frame', () => {
  const k = new ScoreKeeper();
  assert.doesNotThrow(() => k.sample());
});

test('every grade the card can print is on the analytics allowlist', () => {
  // eventField() drops an event whose value is not allowlisted, so a new grade
  // added to score.js would silently stop being counted.
  assert.deepEqual([...EVENTS.song_scored.grade].sort(), [...GRADE_NAMES].sort());
});
