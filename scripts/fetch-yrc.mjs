#!/usr/bin/env node
// Fetch NetEase word-level (yrc) + line-level (lrc) lyrics for a track and write
// them next to each other for truth-check.mjs.
//
// Usage:
//   node scripts/fetch-yrc.mjs "Artist" "Track" [outPrefix]
//   node scripts/fetch-yrc.mjs Adele "Someone Like You" fixtures/adele-someone

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fetchNeteaseLyrics } from '../lib/netease.mjs';

const [artist, track, outArg] = process.argv.slice(2);
if (!artist || !track) {
  console.error('usage: node scripts/fetch-yrc.mjs <artist> <track> [outPrefix]');
  process.exit(1);
}

const data = await fetchNeteaseLyrics({ artist, track });
if (!data) {
  console.error(`✗ no NetEase hit for "${artist} — ${track}"`);
  process.exit(1);
}

const slug =
  outArg ||
  `${(data.meta.artistName || artist).replace(/\W+/g, '_')}_${(data.meta.trackName || track).replace(/\W+/g, '_')}`;
const base = resolve(slug);
mkdirSync(dirname(base), { recursive: true });

if (data.yrc) {
  writeFileSync(`${base}.yrc`, data.yrc);
  console.log(`✓ yrc  → ${base}.yrc  (${data.yrc.length} bytes)`);
} else {
  console.warn('⚠ no word-level yrc — only line-level lrc available');
}
if (data.lrc) {
  writeFileSync(`${base}.lrc`, data.lrc);
  console.log(`✓ lrc  → ${base}.lrc  (${data.lrc.length} bytes)`);
}
console.log(
  `  match: ${data.meta.artistName} — ${data.meta.trackName}` +
    (data.meta.duration ? ` (${data.meta.duration.toFixed(1)}s)` : '')
);
if (!data.yrc) process.exit(2);
