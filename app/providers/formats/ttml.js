// Apple-style TTML (Timed Text Markup Language) lyrics → canonical timeline.
//
// This is the format Apple Music ships karaoke lyrics in: labels deliver a TTML
// file and the client never aligns anything. Importing it means a track that
// already has authored word timing skips forced alignment entirely.
//
// The subset we care about:
//
//   <tt itunes:timing="Word" xml:lang="en">
//     <head><metadata>
//       <ttm:agent type="person" xml:id="v1"><ttm:name type="full">Adele</ttm:name></ttm:agent>
//     </metadata></head>
//     <body>
//       <div itunes:song-part="Verse">
//         <p begin="00:14.700" end="00:20.100" ttm:agent="v1" itunes:key="L1">
//           <span begin="00:14.700" end="00:14.860">I</span>
//           <span begin="00:14.860" end="00:15.220">heard</span>
//           <span ttm:role="x-bg"><span begin="..." end="...">ooh</span></span>
//           <span ttm:role="x-translation" xml:lang="es">Escuché</span>
//         </p>
//       </div>
//     </body>
//   </tt>
//
// Syllable spans that are NOT separated by whitespace belong to the same display
// word (`<span>Hel</span><span>lo</span>`), so they are merged into one token and
// the sub-spans kept on `word.syllables` for a future per-syllable wipe.
//
// Deliberately hand-rolled rather than DOMParser so the parser is unit-testable
// in node and behaves identically in the web build.

import { tokenizeLine, wordsAcrossSpan } from './estimate.js';

const TRAILING_LINE_SECONDS = 4;

/* ---------------------------------------------------------------- XML scan */

const TAG_RE = /<(\/)?([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/)?>/g;
const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
const VOID_SKIP = /^<(\?|!)/;

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return m;
    }
  });
}

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * Parse XML into a minimal element tree.
 * Nodes: `{ name, attrs, children }` for elements, `{ text }` for character data.
 * @returns {{ name: string, attrs: object, children: Array }|null} the root element
 */
export function parseXml(xml) {
  const src = stripNoise(String(xml || ''));
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];

  let cursor = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) {
    if (VOID_SKIP.test(m[0])) continue;
    pushText(stack[stack.length - 1], src.slice(cursor, m.index));
    cursor = TAG_RE.lastIndex;

    const [, closing, name, rawAttrs, selfClose] = m;
    if (closing) {
      // Pop to the matching open tag; tolerate stray closers.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = { name, attrs: parseAttrs(rawAttrs), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  pushText(stack[stack.length - 1], src.slice(cursor));

  return root.children.find((c) => c.name) || null;
}

function stripNoise(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

function pushText(parent, raw) {
  if (!raw) return;
  parent.children.push({ text: decodeEntities(raw) });
}

/* ------------------------------------------------------------- timestamps */

const CLOCK_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;
const OFFSET_RE = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/;

/**
 * TTML time expression → seconds. Supports clock time (`hh:mm:ss.fff`,
 * `mm:ss.fff`) and offset time (`12.5s`, `1400ms`, `1.5m`). Frame- and
 * tick-based offsets need a frame rate we don't have; those return null.
 * @returns {number|null}
 */
export function parseTtmlTime(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  const clock = s.match(CLOCK_RE);
  if (clock) {
    const h = clock[1] ? parseInt(clock[1], 10) : 0;
    const min = parseInt(clock[2], 10);
    const sec = parseFloat(clock[3]);
    return h * 3600 + min * 60 + sec;
  }

  const offset = s.match(OFFSET_RE);
  if (offset) {
    const n = parseFloat(offset[1]);
    switch (offset[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 's': return n;
      case 'ms': return n / 1000;
      default: return null;
    }
  }

  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // bare seconds
  return null;
}

/* ------------------------------------------------------------ TTML → lines */

const ROLE_BG = 'x-bg';
const ROLE_TRANSLATION = 'x-translation';
const ROLE_ROMAN = 'x-roman';

function attr(node, ...names) {
  for (const n of names) {
    const v = node.attrs?.[n];
    if (v != null) return v;
  }
  return undefined;
}

function role(node) {
  return attr(node, 'ttm:role', 'role');
}

/** Concatenated text of a node's subtree. */
function textOf(node) {
  if (node.text != null) return node.text;
  return (node.children || []).map(textOf).join('');
}

function findAll(node, name, out = []) {
  for (const child of node.children || []) {
    if (child.name === name) out.push(child);
    if (child.children) findAll(child, name, out);
  }
  return out;
}

function readAgents(root) {
  const agents = [];
  for (const node of findAll(root, 'ttm:agent').concat(findAll(root, 'agent'))) {
    const id = attr(node, 'xml:id', 'id');
    if (!id) continue;
    const nameNode = (node.children || []).find((c) => c.name === 'ttm:name' || c.name === 'name');
    agents.push({
      id,
      type: attr(node, 'type') || 'person',
      name: nameNode ? textOf(nameNode).trim() : undefined,
    });
  }
  return agents;
}

/**
 * Collect the timed spans of a <p>, merging syllables that aren't separated by
 * whitespace into a single display word.
 */
function readWords(pNode) {
  const spans = [];
  let sawGapBefore = true; // leading boundary: first span always starts a word

  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.text != null) {
        if (/\s/.test(child.text)) sawGapBefore = true;
        continue;
      }
      if (child.name !== 'span') continue;
      const r = role(child);
      if (r === ROLE_BG || r === ROLE_TRANSLATION || r === ROLE_ROMAN) continue;

      const begin = parseTtmlTime(attr(child, 'begin'));
      if (begin == null) {
        // Untimed wrapper span — descend, its children may be timed.
        walk(child);
        continue;
      }
      const end = parseTtmlTime(attr(child, 'end'));
      const text = textOf(child);
      if (!text.trim()) {
        sawGapBefore = true;
        continue;
      }
      spans.push({ text, start: begin, end: end != null ? end : begin, boundary: sawGapBefore });
      sawGapBefore = /\s$/.test(text);
    }
  };
  walk(pNode);

  // Merge non-boundary spans into the preceding word as syllables.
  const words = [];
  for (const span of spans) {
    const text = span.text.trim();
    if (!text) continue;
    if (span.boundary || !words.length) {
      words.push({
        text,
        start: span.start,
        end: span.end,
        syllables: [{ text, start: span.start, end: span.end }],
      });
    } else {
      const w = words[words.length - 1];
      w.text += text;
      w.end = Math.max(w.end, span.end);
      w.syllables.push({ text, start: span.start, end: span.end });
    }
  }
  for (const w of words) {
    if (w.syllables.length < 2) delete w.syllables;
  }
  return words;
}

/** Background-vocal groups (`ttm:role="x-bg"`) inside a <p>. */
function readBackground(pNode) {
  const groups = [];
  for (const child of pNode.children || []) {
    if (child.name !== 'span' || role(child) !== ROLE_BG) continue;
    const words = readWords(child);
    if (!words.length) {
      const text = textOf(child).trim();
      if (!text) continue;
      const start = parseTtmlTime(attr(child, 'begin'));
      const end = parseTtmlTime(attr(child, 'end'));
      if (start == null) continue;
      groups.push({ start, end: end ?? start, words: [{ text, start, end: end ?? start }] });
      continue;
    }
    groups.push({
      start: parseTtmlTime(attr(child, 'begin')) ?? words[0].start,
      end: parseTtmlTime(attr(child, 'end')) ?? words[words.length - 1].end,
      words,
    });
  }
  return groups;
}

/** Inline translation / romanization overlays on a <p>. */
function readOverlays(pNode) {
  const out = {};
  for (const child of pNode.children || []) {
    if (child.name !== 'span') continue;
    const r = role(child);
    const text = textOf(child).trim();
    if (!text) continue;
    if (r === ROLE_ROMAN) {
      out.roman = text;
    } else if (r === ROLE_TRANSLATION) {
      out.translation = text;
      const lang = attr(child, 'xml:lang', 'lang') || '';
      if (/^en\b/i.test(lang) || lang.toLowerCase() === 'en') out.english = text;
    }
  }
  return out;
}

/** Plain sung text of a <p>, excluding bg/translation/roman spans. */
function lineText(pNode) {
  let out = '';
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.text != null) {
        out += child.text;
        continue;
      }
      if (child.name !== 'span') continue;
      const r = role(child);
      if (r === ROLE_BG || r === ROLE_TRANSLATION || r === ROLE_ROMAN) continue;
      walk(child);
    }
  };
  walk(pNode);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Parse Apple-style TTML lyrics into the canonical timeline.
 *
 * @param {string} xml
 * @returns {{ lines: Array, duration: number, agents?: Array, sections?: Array, wordSync: boolean, hasRoman?: boolean }}
 */
export function parseTTML(xml) {
  const root = parseXml(xml);
  if (!root) return emptyResult();

  const agents = readAgents(root);
  const sections = [];
  const lines = [];
  let anyWordTiming = false;
  let hasRoman = false;

  const body = findAll(root, 'body')[0] || root;
  const divs = (body.children || []).filter((c) => c.name === 'div');
  const containers = divs.length ? divs : [body];

  for (const div of containers) {
    const part = attr(div, 'itunes:song-part', 'itunes:songPart', 'song-part');
    const sectionStartIdx = lines.length;

    for (const p of (div.children || []).filter((c) => c.name === 'p')) {
      const start = parseTtmlTime(attr(p, 'begin'));
      if (start == null) continue;
      const declaredEnd = parseTtmlTime(attr(p, 'end'));

      const words = readWords(p);
      const overlays = readOverlays(p);
      const bg = readBackground(p);

      let lineWords = words;
      let end = declaredEnd;
      if (words.length) {
        anyWordTiming = true;
        if (end == null) end = words[words.length - 1].end;
      } else {
        // Line-level TTML: same syllable-weighted spread LRC gets.
        const tokens = tokenizeLine(lineText(p));
        if (!tokens.length) continue;
        if (end == null) end = start + tokens.length * 0.45;
        lineWords = wordsAcrossSpan(tokens, start, end);
      }

      const line = {
        start,
        end: Math.max(end ?? start, start),
        words: lineWords,
        agent: attr(p, 'ttm:agent', 'agent') || undefined,
        key: attr(p, 'itunes:key') || undefined,
      };
      if (overlays.roman) {
        line.roman = overlays.roman;
        hasRoman = true;
      }
      if (overlays.translation) line.translation = overlays.translation;
      if (overlays.english) line.english = overlays.english;
      if (bg.length) line.bg = bg;
      if (part) line.songPart = part;
      lines.push(line);
    }

    if (part && lines.length > sectionStartIdx) {
      const first = lines[sectionStartIdx];
      const last = lines[lines.length - 1];
      sections.push({
        part,
        start: parseTtmlTime(attr(div, 'begin')) ?? first.start,
        end: parseTtmlTime(attr(div, 'end')) ?? last.end,
      });
    }
  }

  if (!lines.length) return emptyResult();
  lines.sort((a, b) => a.start - b.start);
  closeLineEnds(lines);

  const result = {
    lines,
    duration: lines[lines.length - 1].end,
    wordSync: anyWordTiming,
  };
  if (agents.length) result.agents = agents;
  if (sections.length) result.sections = sections;
  if (hasRoman) result.hasRoman = true;
  return result;
}

/** Hold each word until the next begins; don't let a line outrun the next one. */
function closeLineEnds(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const words = line.words;
    for (let j = 0; j < words.length - 1; j++) {
      if (words[j].end < words[j + 1].start) words[j].end = words[j + 1].start;
    }
    const next = lines[i + 1];
    const lastEnd = words.length ? words[words.length - 1].end : line.end;
    // Authored word ends are ground truth — clamp the LINE, never stretch a word.
    line.end = next
      ? Math.min(Math.max(line.end, lastEnd), next.start)
      : Math.max(line.end, lastEnd + TRAILING_LINE_SECONDS);
  }
}

function emptyResult() {
  return { lines: [], duration: 0, wordSync: false };
}
