import { parseLRC } from './lrc.js';
import { parseSRT } from './srt.js';
import { parseASS } from './ass.js';
import { parseYRC } from './yrc.js';
import { parseRichsync } from './richsync.js';
import { parseTTML } from './ttml.js';

const EXT = {
  lrc: 'lrc',
  srt: 'srt',
  ass: 'ass',
  ssa: 'ass',
  yrc: 'yrc',
  ttml: 'ttml',
};

export function detectFormat(text, filename) {
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (EXT[ext]) return EXT[ext];
  }
  const head = text.slice(0, 500);
  // TTML before the rest: an .xml sidecar has no distinguishing extension.
  if (/<tt[\s>]/.test(head) && /(xmlns|itunes:timing|ttml)/i.test(head)) return 'ttml';
  if (head.includes('[Script Info]') || /^Dialogue:/m.test(head)) return 'ass';
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return 'srt';
  if (/\[\d{1,2}:\d{2}/.test(head)) return 'lrc';
  return 'lrc';
}

const KNOWN = new Set(['lrc', 'srt', 'ass', 'yrc', 'richsync', 'ttml']);

export function parseLyrics(text, formatOrFilename) {
  const format = KNOWN.has(formatOrFilename)
    ? formatOrFilename
    : detectFormat(text, formatOrFilename);

  switch (format) {
    case 'ttml':
      return { timeline: parseTTML(text), format: 'ttml' };
    case 'yrc':
      return { timeline: parseYRC(text), format: 'yrc' };
    case 'richsync':
      return { timeline: parseRichsync(text), format: 'richsync' };
    case 'srt':
      return { timeline: parseSRT(text), format: 'srt' };
    case 'ass':
      return { timeline: parseASS(text), format: 'ass' };
    default:
      return { timeline: parseLRC(text), format: 'lrc' };
  }
}

export { parseLRC, parseSRT, parseASS, parseYRC, parseRichsync, parseTTML };
