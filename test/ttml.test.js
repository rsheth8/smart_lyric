import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTTML, parseXml, parseTtmlTime } from '../app/providers/formats/ttml.js';
import { detectFormat, parseLyrics } from '../app/providers/formats/index.js';
import { needsVocalAlign } from '../app/align.js';

const WORD_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    itunes:timing="Word" xml:lang="en">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"><ttm:name type="full">Adele</ttm:name></ttm:agent>
      <ttm:agent type="group" xml:id="v2"><ttm:name type="full">Choir</ttm:name></ttm:agent>
    </metadata>
  </head>
  <body>
    <div itunes:song-part="Verse" begin="00:14.700" end="00:20.100">
      <p begin="00:14.700" end="00:16.000" ttm:agent="v1" itunes:key="L1">
        <span begin="00:14.700" end="00:14.860">I </span>
        <span begin="00:14.860" end="00:15.220">heard </span>
        <span begin="00:15.220" end="00:16.000">that</span>
        <span ttm:role="x-translation" xml:lang="es">Escuché que</span>
      </p>
      <p begin="00:17.000" end="00:20.100" ttm:agent="v1">
        <span begin="00:17.000" end="00:17.400">you&apos;re</span>
        <span ttm:role="x-bg" begin="00:19.000" end="00:20.100">
          <span begin="00:19.000" end="00:20.100">ooh</span>
        </span>
      </p>
    </div>
    <div itunes:song-part="Chorus">
      <p begin="00:25.000" end="00:27.500" ttm:agent="v2">
        <span begin="00:25.000" end="00:25.900">Ne</span><span begin="00:25.900" end="00:27.500">ver</span>
      </p>
    </div>
  </body>
</tt>`;

const LINE_TTML = `<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Line" xml:lang="en">
  <body><div>
    <p begin="10s" end="13s">Hello there world</p>
    <p begin="13s" end="16s">Second line here</p>
  </div></body>
</tt>`;

describe('parseTtmlTime', () => {
  test('parses clock time with and without hours', () => {
    assert.equal(parseTtmlTime('00:14.700'), 14.7);
    assert.equal(parseTtmlTime('01:02:03.500'), 3723.5);
  });

  test('parses offset time', () => {
    assert.equal(parseTtmlTime('12.5s'), 12.5);
    assert.equal(parseTtmlTime('1400ms'), 1.4);
    assert.equal(parseTtmlTime('1.5m'), 90);
  });

  test('returns null for frames/ticks and junk', () => {
    assert.equal(parseTtmlTime('10f'), null);
    assert.equal(parseTtmlTime(''), null);
    assert.equal(parseTtmlTime(undefined), null);
  });
});

describe('parseXml', () => {
  test('handles self-closing tags, comments and entities', () => {
    const root = parseXml('<a><!-- x --><b k="1&amp;2"/>hi</a>');
    assert.equal(root.name, 'a');
    assert.equal(root.children[0].name, 'b');
    assert.equal(root.children[0].attrs.k, '1&2');
    assert.equal(root.children[1].text, 'hi');
  });

  test('tolerates attribute values containing >', () => {
    const root = parseXml('<a t="x>y"><b/></a>');
    assert.equal(root.attrs.t, 'x>y');
    assert.equal(root.children[0].name, 'b');
  });
});

describe('parseTTML word-level', () => {
  const tl = parseTTML(WORD_TTML);

  test('reads word spans with real timings', () => {
    assert.equal(tl.wordSync, true);
    assert.equal(tl.lines.length, 3);
    assert.deepEqual(
      tl.lines[0].words.map((w) => w.text),
      ['I', 'heard', 'that']
    );
    assert.equal(tl.lines[0].words[1].start, 14.86);
    assert.equal(tl.lines[0].words[1].end, 15.22);
  });

  test('merges syllable spans with no whitespace into one word', () => {
    const line = tl.lines[2];
    assert.deepEqual(line.words.map((w) => w.text), ['Never']);
    assert.equal(line.words[0].start, 25);
    assert.equal(line.words[0].end, 27.5);
    assert.equal(line.words[0].syllables.length, 2);
    assert.equal(line.words[0].syllables[1].text, 'ver');
  });

  test('captures agents and per-line agent ids', () => {
    assert.deepEqual(tl.agents.map((a) => a.id), ['v1', 'v2']);
    assert.equal(tl.agents[0].name, 'Adele');
    assert.equal(tl.lines[0].agent, 'v1');
    assert.equal(tl.lines[2].agent, 'v2');
  });

  test('captures song-part sections', () => {
    assert.deepEqual(tl.sections.map((s) => s.part), ['Verse', 'Chorus']);
    assert.equal(tl.sections[0].start, 14.7);
    assert.equal(tl.sections[1].start, 25);
  });

  test('keeps background vocals out of the lead word list', () => {
    const line = tl.lines[1];
    assert.deepEqual(line.words.map((w) => w.text), ["you're"]);
    assert.equal(line.bg.length, 1);
    assert.equal(line.bg[0].words[0].text, 'ooh');
    assert.equal(line.bg[0].start, 19);
  });

  test('attaches inline translation', () => {
    assert.equal(tl.lines[0].translation, 'Escuché que');
  });

  test('does not stretch authored word ends to fill the line', () => {
    // "that" ends at its authored 16.0 even though line 2 starts at 17.0.
    const last = tl.lines[0].words[2];
    assert.equal(last.end, 16);
  });
});

describe('parseTTML line-level', () => {
  const tl = parseTTML(LINE_TTML);

  test('spreads words across the line span', () => {
    assert.equal(tl.wordSync, false);
    assert.equal(tl.lines.length, 2);
    assert.equal(tl.lines[0].words.length, 3);
    assert.ok(tl.lines[0].words[0].start >= 10);
    assert.ok(tl.lines[0].words[2].end <= 13.001);
  });

  test('still needs forced alignment despite the ttml format name', () => {
    assert.equal(needsVocalAlign(tl, { format: 'ttml' }), true);
  });
});

describe('format registration', () => {
  test('detects ttml by content and by extension', () => {
    assert.equal(detectFormat(WORD_TTML), 'ttml');
    assert.equal(detectFormat('anything', 'song.ttml'), 'ttml');
  });

  test('parseLyrics routes ttml', () => {
    const { timeline, format } = parseLyrics(WORD_TTML);
    assert.equal(format, 'ttml');
    assert.equal(timeline.lines.length, 3);
  });

  test('word-level ttml skips forced alignment', () => {
    const { timeline } = parseLyrics(WORD_TTML);
    assert.equal(needsVocalAlign(timeline, { format: 'ttml' }), false);
  });

  test('does not misdetect lrc as ttml', () => {
    assert.equal(detectFormat('[00:14.70] I heard that'), 'lrc');
  });
});
