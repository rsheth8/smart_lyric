import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  blockify,
  chorusFlags,
  deriveSections,
  resolveSections,
  sectionIndexAt,
} from '../app/providers/formats/sections.js';
import { parseLRC } from '../app/providers/formats/lrc.js';
import { wordsAcrossSpan } from '../app/providers/formats/estimate.js';
import { agentSides } from '../app/display.js';

/**
 * Build a timeline from `[[start, end, 'text'], ...]`, using the SAME word
 * spread the LRC parser uses. That matters: `wordsAcrossSpan` onset-packs words
 * and parks the leftover on a held final word, which is exactly the signal
 * section derivation reads to find instrumental gaps. An even spread would make
 * these fixtures lie.
 */
function makeTimeline(spec, duration) {
  const lines = spec.map(([start, end, text]) => ({
    start,
    end,
    words: wordsAcrossSpan(text.split(' '), start, end),
  }));
  return { lines, duration: duration ?? lines[lines.length - 1].end };
}

describe('blockify', () => {
  test('splits on a real gap, measured from where the voice stops', () => {
    // Line ends are the NEXT line's start (LRC convention), so the gap only
    // shows up via the held-tail rule.
    const tl = makeTimeline([
      [0, 4, 'aaa bbb'],
      [4, 20, 'ccc ddd'], // sings ~2s, then 14s of nothing
      [20, 24, 'eee fff'],
    ]);
    const blocks = blockify(tl.lines);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].lines.length, 2);
    assert.equal(blocks[1].lines.length, 1);
  });

  test('returns nothing for an empty timeline', () => {
    assert.deepEqual(blockify([]), []);
    assert.deepEqual(blockify(null), []);
  });
});

describe('chorusFlags', () => {
  test('marks a repeated multi-line passage', () => {
    const tl = makeTimeline([
      [0, 4, 'walking down a lonely road'],
      [4, 8, 'thinking about the years'],
      [8, 12, 'never gonna let you go now'],
      [12, 16, 'never gonna say goodbye friend'],
      [16, 20, 'counting all the empty rooms'],
      [20, 24, 'never gonna let you go now'],
      [24, 28, 'never gonna say goodbye friend'],
    ]);
    const flags = chorusFlags(tl.lines);
    assert.deepEqual(flags, [false, false, true, true, false, true, true]);
  });

  test('a single recurring line is a refrain, not a chorus', () => {
    const tl = makeTimeline([
      [0, 4, 'the very same words again'],
      [4, 8, 'something entirely different here'],
      [8, 12, 'the very same words again'],
      [12, 16, 'another unrelated lyric line'],
    ]);
    assert.deepEqual(chorusFlags(tl.lines), [false, false, false, false]);
  });

  test('short interjections never count as a hook', () => {
    const tl = makeTimeline([
      [0, 2, 'oh oh'],
      [2, 4, 'oh oh'],
      [4, 6, 'oh oh'],
      [6, 8, 'oh oh'],
    ]);
    assert.deepEqual(chorusFlags(tl.lines), [false, false, false, false]);
  });
});

describe('deriveSections', () => {
  test('produces an intro, alternating verse/chorus, and an outro', () => {
    const spec = [];
    let t = 20; // 20s instrumental intro
    // Verses differ between repetitions (as real ones do); only the chorus repeats.
    const verses = [
      ['walking down a lonely road', 'thinking about the years gone'],
      ['counting all the empty rooms', 'wondering where the time ran'],
    ];
    const chorus = ['never gonna let you go now', 'never gonna say goodbye friend'];
    for (let rep = 0; rep < 2; rep++) {
      for (const l of verses[rep]) { spec.push([t, t + 8, l]); t += 8; }
      for (const l of chorus) { spec.push([t, t + 8, l]); t += 8; }
    }
    const sections = deriveSections(makeTimeline(spec, t + 20));

    assert.deepEqual(
      sections.map((s) => s.part),
      ['Intro', 'Verse', 'Chorus', 'Verse', 'Chorus', 'Outro']
    );
    assert.equal(sections[0].start, 0);
    assert.equal(sections[0].end, 20);
    assert.ok(sections.every((s) => s.derived === true));
  });

  test('marks a long instrumental gap as a Break', () => {
    const chorus = ['never gonna let you go now', 'never gonna say goodbye friend'];
    const spec = [
      [0, 8, 'walking down a lonely road'],
      [8, 16, 'thinking about the years gone'],
      [16, 24, chorus[0]],
      [24, 32, chorus[1]],
      // The last line before the solo sings its words, then 30s of guitar.
      [32, 62, 'holding out the final note'],
      [62, 70, 'counting all the empty rooms'],
      [70, 78, chorus[0]],
      [78, 86, chorus[1]],
    ];
    const parts = deriveSections(makeTimeline(spec, 86)).map((s) => s.part);
    assert.ok(parts.includes('Break'), `expected a Break in ${parts.join(',')}`);
  });

  test('refuses to invent structure for a too-short timeline', () => {
    assert.deepEqual(deriveSections(makeTimeline([[0, 4, 'one two'], [4, 8, 'three four']])), []);
    assert.deepEqual(deriveSections({ lines: [] }), []);
    assert.deepEqual(deriveSections(null), []);
  });

  test('sections are ordered and never overlap', () => {
    const lrc = fs.readFileSync(
      new URL('../Nirvana_Smells_Like_Teen_Spirit.lrc', import.meta.url),
      'utf8'
    );
    const sections = deriveSections(parseLRC(lrc));
    assert.ok(sections.length >= 4);
    for (let i = 0; i < sections.length; i++) {
      assert.ok(sections[i].end > sections[i].start, 'section has positive span');
      if (i) assert.ok(sections[i].start >= sections[i - 1].end - 0.01, 'no overlap');
    }
  });

  test('finds real structure in a real lyric file', () => {
    const lrc = fs.readFileSync(
      new URL('../Adele_Someone_Like_You.lrc', import.meta.url),
      'utf8'
    );
    const parts = deriveSections(parseLRC(lrc)).map((s) => s.part);
    assert.equal(parts[0], 'Intro');
    assert.ok(parts.filter((p) => p === 'Chorus').length >= 2, 'found repeated choruses');
    assert.ok(parts.filter((p) => p === 'Verse').length >= 2, 'found verses');
  });

  test('no section is a sliver', () => {
    const lrc = fs.readFileSync(new URL('../Tum_Hi_Ho.lrc', import.meta.url), 'utf8');
    for (const s of deriveSections(parseLRC(lrc))) {
      assert.ok(s.end - s.start >= 5, `${s.part} spans only ${(s.end - s.start).toFixed(1)}s`);
    }
  });
});

describe('resolveSections', () => {
  test('authored TTML sections win over derivation', () => {
    const tl = makeTimeline([[0, 4, 'a b'], [4, 8, 'c d']]);
    tl.sections = [{ part: 'Bridge', start: 0, end: 8 }];
    assert.deepEqual(resolveSections(tl), [{ part: 'Bridge', start: 0, end: 8 }]);
  });

  test('falls back to derivation when none are authored', () => {
    const lrc = fs.readFileSync(new URL('../Adele_Someone_Like_You.lrc', import.meta.url), 'utf8');
    assert.ok(resolveSections(parseLRC(lrc)).length >= 4);
  });
});

describe('sectionIndexAt', () => {
  const sections = [
    { part: 'Intro', start: 0, end: 10 },
    { part: 'Verse', start: 10, end: 30 },
    { part: 'Chorus', start: 30, end: 50 },
  ];

  test('finds the containing section', () => {
    assert.equal(sectionIndexAt(sections, 0), 0);
    assert.equal(sectionIndexAt(sections, 9.99), 0);
    assert.equal(sectionIndexAt(sections, 10), 1);
    assert.equal(sectionIndexAt(sections, 49.9), 2);
  });

  test('returns -1 outside the song and for junk input', () => {
    assert.equal(sectionIndexAt(sections, 50), -1);
    assert.equal(sectionIndexAt(sections, -1), -1);
    assert.equal(sectionIndexAt([], 5), -1);
    assert.equal(sectionIndexAt(sections, NaN), -1);
  });

  test('a stale hint still resolves correctly', () => {
    assert.equal(sectionIndexAt(sections, 35, 0), 2);
    assert.equal(sectionIndexAt(sections, 5, 99), 0);
  });
});

describe('agentSides', () => {
  test('stages two singers on opposite sides, in first-appearance order', () => {
    const sides = agentSides([{ agent: 'v1' }, { agent: 'v2' }, { agent: 'v1' }]);
    assert.equal(sides.get('v1'), 'a');
    assert.equal(sides.get('v2'), 'b');
  });

  test('a third voice goes centre rather than fighting for an edge', () => {
    const sides = agentSides([{ agent: 'v1' }, { agent: 'v2' }, { agent: 'v3' }]);
    assert.equal(sides.get('v3'), 'c');
  });

  test('a single voice is not a duet', () => {
    assert.equal(agentSides([{ agent: 'v1' }, { agent: 'v1' }]), null);
    assert.equal(agentSides([{}, {}]), null);
    assert.equal(agentSides([]), null);
    assert.equal(agentSides(null), null);
  });
});
