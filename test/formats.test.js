import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLyricsFilename, basenameWithoutExt } from '../app/local-lyrics.js';
import { basenamesMatch } from '../app/providers/lyrics/local.js';
import { parseSRT } from '../app/providers/formats/srt.js';
import { parseASS } from '../app/providers/formats/ass.js';
import { parseYRC } from '../app/providers/formats/yrc.js';
import { detectFormat, parseLyrics } from '../app/providers/formats/index.js';
import { fetchLyrics } from '../app/providers/lyrics/index.js';
import { validateTimeline, emptyTimeline } from '../app/timeline.js';
import { PassiveClock, StreamingClock } from '../app/clock.js';
import { alignFingerprints, parseFingerprint } from '../electron/fingerprint.cjs';

test('parseLyricsFilename splits artist and track', () => {
  assert.deepEqual(parseLyricsFilename('Radiohead - Karma Police.lrc'), {
    artist: 'Radiohead',
    track: 'Karma Police',
  });
  assert.deepEqual(parseLyricsFilename('Karma Police.lrc'), { artist: '', track: 'Karma Police' });
});

test('basenamesMatch pairs audio and lyrics files', () => {
  assert.ok(basenamesMatch('song.flac', 'Song.lrc'));
  assert.ok(!basenamesMatch('a.flac', 'b.lrc'));
});

test('parseSRT produces timed lines', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world`;
  const { lines } = parseSRT(srt);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].start, 1);
  assert.equal(lines[0].words[0].text, 'Hello');
});

test('parseASS parses Dialogue karaoke lines', () => {
  const ass = `[Script Info]
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\k50}Hello {\\k50}world`;
  const { lines } = parseASS(ass);
  assert.ok(lines.length >= 1);
  assert.ok(lines[0].words.length >= 1);
});

test('parseYRC gives each word its own vocal timing', () => {
  // [lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)text  — uneven word spacing.
  const yrc = '[1000,900](1000,200,0)aa (1200,100,0)bb (1300,600,0)cc';
  const { lines } = parseYRC(yrc);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].start, 1);
  const [a, b, c] = lines[0].words;
  assert.deepEqual([a.text, b.text, c.text], ['aa', 'bb', 'cc']);
  assert.equal(a.start, 1);
  assert.equal(b.start, 1.2); // real onset, not an even 1/3 split of the line
  assert.equal(c.start, 1.3);
  // each word holds until the next begins
  assert.equal(a.end, b.start);
  assert.equal(b.end, c.start);
});

test('parseYRC skips JSON metadata lines and empty input', () => {
  const yrc = '{"t":0,"c":[{"tx":"Producer: X"}]}\n[2000,300](2000,300,0)hi';
  const { lines } = parseYRC(yrc);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words[0].text, 'hi');
  assert.deepEqual(parseYRC('').lines, []);
});

test('parseLyrics routes yrc to the word-level parser', () => {
  const { timeline, format } = parseLyrics('[0,500](0,500,0)hey', 'yrc');
  assert.equal(format, 'yrc');
  assert.equal(timeline.lines[0].words[0].text, 'hey');
});

test('detectFormat identifies formats', () => {
  assert.equal(detectFormat('[00:01.00]Hi', 'x.lrc'), 'lrc');
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi', 'x.srt'), 'srt');
  assert.equal(detectFormat('[Script Info]\nDialogue: 0,0:0,0:1,Default,,0,0,0,,hi', 'x.ass'), 'ass');
});

test('parseLyrics routes to correct parser', () => {
  const { timeline, format } = parseLyrics('[00:01.00]One line', 'lrc');
  assert.equal(format, 'lrc');
  assert.equal(timeline.lines.length, 1);
});

test('validateTimeline accepts good timelines', () => {
  const t = parseLyrics('[00:01.00]Hi', 'lrc').timeline;
  assert.ok(validateTimeline(t));
  assert.deepEqual(emptyTimeline(), { lines: [], duration: 0 });
});

test('PassiveClock mirrors pushed state', () => {
  const c = new PassiveClock();
  c.push(12.5, true);
  assert.equal(c.now(), 12.5);
  assert.equal(c.isPlaying(), true);
});

test('StreamingClock reads SDK getters', () => {
  let pos = 3;
  const c = new StreamingClock({
    getPosition: () => pos,
    isPlaying: () => true,
  });
  assert.equal(c.now(), 3);
  pos = 9;
  assert.equal(c.now(), 9);
});

test('alignFingerprints finds best offset index', () => {
  const ref = parseFingerprint('1,2,3,4,5,6,7,8');
  const query = parseFingerprint('4,5,6');
  const offset = alignFingerprints(query, ref);
  assert.equal(offset, 3 * 1.024);
});

test('fetchLyrics prefers local file over network', async () => {
  const file = {
    name: 'Test - Song.lrc',
    text: async () => '[00:01.00]Local line',
  };
  const result = await fetchLyrics({ track: 'Song', lyricsFile: file }, { sources: ['local'] });
  assert.equal(result.source, 'local');
  assert.match(result.text, /Local line/);
});
