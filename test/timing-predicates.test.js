import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsVocalAlign, needsLatencyCalib } from '../app/align.js';

const timeline = (extra = {}) => ({
  lines: [{ start: 1, end: 3, words: [{ text: 'a' }, { text: 'b' }] }],
  ...extra,
});

// The core distinction: word-level timing says where the words sit RELATIVE to
// each other. It says nothing about how long audio takes to reach your ears.

test('catalog word-sync skips word alignment but STILL needs latency calibration', () => {
  const tl = timeline();
  assert.equal(needsVocalAlign(tl, { format: 'yrc' }), false, 'no CTC refinement needed');
  assert.equal(needsLatencyCalib(tl, { autoTiming: true }), true, 'but latency is unmeasured');
});

test('richsync behaves the same as yrc', () => {
  const tl = timeline();
  assert.equal(needsVocalAlign(tl, { format: 'richsync' }), false);
  assert.equal(needsLatencyCalib(tl, { autoTiming: true }), true);
});

test('a cached already-aligned timeline still needs latency calibration', () => {
  // timeline-cache.js marks lines _vocalAligned and sets aligned:true on load,
  // so EVERY song's second play hit this — not just word-sync ones.
  const tl = timeline({ aligned: true });
  tl.lines[0]._vocalAligned = true;
  assert.equal(needsVocalAlign(tl, { format: 'lrc' }), false, 'words already aligned');
  assert.equal(needsLatencyCalib(tl, { autoTiming: true }), true, 'latency is a separate question');
});

test('auto-timing off means no calibration', () => {
  assert.equal(needsLatencyCalib(timeline(), { autoTiming: false }), false);
});

test('no timeline / no worded lines means nothing to calibrate against', () => {
  assert.equal(needsLatencyCalib(null, { autoTiming: true }), false);
  assert.equal(needsLatencyCalib({ lines: [] }, { autoTiming: true }), false);
  assert.equal(
    needsLatencyCalib({ lines: [{ start: 0, end: 1, words: [] }] }, { autoTiming: true }),
    false
  );
});

test('plain line-level lyrics still need both', () => {
  const tl = timeline();
  assert.equal(needsVocalAlign(tl, { format: 'lrc' }), true);
  assert.equal(needsLatencyCalib(tl, { autoTiming: true }), true);
});

test('one aligned line does NOT stop the rest of the song needing CTC', () => {
  const tl = {
    aligned: true, // stale whole-timeline flag from the old bug
    lines: [
      { start: 0, end: 2, words: [{ text: 'a' }], _vocalAligned: true },
      { start: 2, end: 4, words: [{ text: 'b' }] },
    ],
  };
  assert.equal(needsVocalAlign(tl, { format: 'lrc' }), true, 'pending lines still need work');
});
