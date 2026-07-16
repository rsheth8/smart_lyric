import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsRomanization } from '../app/providers/translate.js';

test('needsRomanization detects Devanagari (Hindi)', () => {
  assert.equal(needsRomanization(['तुम ही हो', 'मेरी जान']), true);
});

test('needsRomanization detects CJK and Hangul', () => {
  assert.equal(needsRomanization(['夜に駆ける', '君はまだ']), true);
  assert.equal(needsRomanization(['봄날', '보고 싶다']), true);
});

test('needsRomanization detects Punjabi (Gurmukhi) and other Indic scripts', () => {
  assert.equal(needsRomanization(['ਤੂੰ ਹੀ ਹੈਂ', 'ਮੇਰਾ ਦਿਲ']), true); // Gurmukhi
  assert.equal(needsRomanization(['আমি তোমায়']), true); // Bengali
  assert.equal(needsRomanization(['நான் உன்னை']), true); // Tamil
});

test('needsRomanization is false for already-Latin lyrics', () => {
  assert.equal(needsRomanization(['Look at the stars', 'How they shine for you']), false);
  // Already-romanized Hindi (Latin letters) needs no further romanization.
  assert.equal(needsRomanization(['Tum hi ho', 'Meri jaan']), false);
});

test('needsRomanization ignores a stray accent / symbol', () => {
  assert.equal(needsRomanization(['Café del mar', 'Naïve']), false);
});
