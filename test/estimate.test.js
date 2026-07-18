import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitPlainLines,
  estimateTimeline,
  tokenizeLine,
  wordsAcrossSpan,
} from '../app/providers/formats/estimate.js';
import { extractLyricsFromHtml } from '../lib/genius.mjs';
import { transcriptToPlainLyrics } from '../lib/transcript-text.mjs';
import { chunksToTimeline } from '../app/providers/formats/asr-timeline.js';

test('splitPlainLines trims and preserves blank spacers', () => {
  const out = splitPlainLines('  a \n\n b ');
  assert.deepEqual(out, ['a', '', 'b']);
});

test('estimateTimeline spreads sung lines across the duration', () => {
  const tl = estimateTimeline('one\ntwo\nthree\nfour', { duration: 40 });
  assert.equal(tl.estimated, true);
  assert.equal(tl.lines.length, 4);
  assert.equal(tl.lines[0].start, 0);
  assert.ok(Math.abs(tl.lines[0].end - 10) < 1e-9);
  assert.ok(Math.abs(tl.lines[3].end - 40) < 1e-9);
});

test('estimateTimeline drops blank lines from the timeline', () => {
  const tl = estimateTimeline('a\n\n\nb', { duration: 20 });
  assert.equal(tl.lines.length, 2);
  assert.equal(tl.lines[0].words[0].text, 'a');
  assert.equal(tl.lines[1].words[0].text, 'b');
});

test('estimateTimeline falls back to secPerLine without a duration', () => {
  const tl = estimateTimeline('a\nb\nc', { secPerLine: 2 });
  assert.ok(Math.abs(tl.lines[1].start - 2) < 1e-9);
  assert.ok(Math.abs(tl.duration - 6) < 1e-9);
});

test('estimateTimeline splits lines into word spans for vocal alignment', () => {
  const tl = estimateTimeline('hello world here', { duration: 10 });
  assert.equal(tl.lines[0].words.length, 3);
  assert.equal(tl.lines[0].words[0].text, 'hello');
  assert.equal(tl.lines[0].words[2].text, 'here');
  assert.ok(tl.lines[0].words[0].end > tl.lines[0].words[0].start);
  assert.ok(tl.lines[0].words[2].end <= tl.lines[0].end + 1e-9);
});

test('tokenizeLine and wordsAcrossSpan preserve coverage', () => {
  const tokens = tokenizeLine('  one two  three ');
  assert.deepEqual(tokens, ['one', 'two', 'three']);
  const words = wordsAcrossSpan(tokens, 0, 9);
  assert.equal(words.length, 3);
  assert.equal(words[0].start, 0);
  assert.ok(Math.abs(words[2].end - 9) < 1e-9);
});

test('extractLyricsFromHtml pulls text and strips section headers', () => {
  const html =
    '<div data-lyrics-container="true">[Verse 1]<br>First line<br>Second line</div>' +
    '<div data-lyrics-container="true">[Chorus]<br>Hook here</div>';
  const out = extractLyricsFromHtml(html);
  assert.equal(out, 'First line\nSecond line\nHook here');
});

test('extractLyricsFromHtml decodes entities', () => {
  const html = '<div data-lyrics-container="true">don&#x27;t stop &amp; go</div>';
  assert.equal(extractLyricsFromHtml(html), "don't stop & go");
});

test('extractLyricsFromHtml drops the excluded contributor/header subtree', () => {
  const html =
    '<div data-lyrics-container="true">' +
    '<div data-exclude-from-selection="true"><button>235 Contributors</button>' +
    '<div>Translations Español</div></div>' +
    'First line<br>Second line</div>';
  assert.equal(extractLyricsFromHtml(html), 'First line\nSecond line');
});

test('transcriptToPlainLyrics splits ASR paragraphs into display lines', () => {
  const out = transcriptToPlainLyrics(
    'First line keeps moving through the night. Second line is short!',
    { maxLineChars: 24 }
  );
  assert.deepEqual(out.split('\n'), [
    'First line keeps moving',
    'through the night.',
    'Second line is short!',
  ]);
});

test('chunksToTimeline maps Whisper timestamps into song time', () => {
  const tl = chunksToTimeline(
    [
      { text: 'Hello world', timestamp: [1.0, 2.5] },
      { text: 'Second line here', timestamp: [3.0, 5.0] },
    ],
    { offsetSec: 10 }
  );
  assert.equal(tl.asrTimed, true);
  assert.equal(tl.lines.length, 2);
  assert.equal(tl.lines[0].start, 11);
  assert.equal(tl.lines[0].end, 12.5);
  assert.equal(tl.lines[0].words[0].text, 'Hello');
  assert.equal(tl.lines[1].start, 13);
});

test('chunksToTimeline skips empty and untimed chunks', () => {
  const tl = chunksToTimeline([
    { text: '  ', timestamp: [0, 1] },
    { text: 'ok', timestamp: null },
    { text: 'kept', timestamp: [2, 3] },
  ]);
  assert.equal(tl.lines.length, 1);
  assert.equal(tl.lines[0].words[0].text, 'kept');
});

test('extractLyricsFromHtml balances nested divs without truncating', () => {
  const html =
    '<div data-lyrics-container="true">Line one<br>' +
    '<div class="annot">Line <span>two</span></div><br>Line three</div>';
  assert.equal(extractLyricsFromHtml(html), 'Line one\nLine two\nLine three');
});
