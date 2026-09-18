// Persist vocal-aligned timelines so the second play of a song is instant.
// Keys prefer a stable provider id (Spotify track id); otherwise artist|track|duration.
// localStorage is fine for compact word spans (DOM refs are stripped on write).
//
// Two properties matter as much as the timings themselves:
//
// 1. Alignments SURVIVE aligner upgrades. `alignVersion` lives per entry, not on
//    the store, so bumping the aligner no longer discards every alignment the
//    user has already paid CPU for. A stale entry is applied *provisionally*:
//    the words are instantly right-ish, and `needsVocalAlign` still returns true
//    so the current aligner refines it in the background.
// 2. Alignments SURVIVE lyric edits. Spans are bound to the recording, not to
//    the exact text we happened to re-fetch, so a provider revising punctuation
//    or splitting a stanza costs two re-aligned lines instead of the whole song
//    (see `rebindCachedTiming`).

import { wordsAcrossSpan } from './providers/formats/estimate.js';

const STORAGE_KEY = 'bar4bar.alignCache.v2';
const STORE_VERSION = 3; // envelope schema: v3 carries per-entry alignVersion
const ALIGN_VERSION = 2; // bump when ALIGNER semantics change (v2: full-song only)
const LEGACY_ALIGN_VERSION = 2; // what a v2 store's entries were produced by
const MAX_ENTRIES = 80;

// Exact-match path: a re-fetched line may drift slightly from the aligned one.
const EXACT_LINE_DRIFT_SEC = 2.5;
// Rebind path: median line drift above this means a different recording, not an edit.
const REBIND_LINE_DRIFT_SEC = 3.0;
// Below this share of words matched, the cache is for different lyrics entirely.
const MIN_REBIND_COVERAGE = 0.6;
// LCS is O(n*m); refuse absurd pairings rather than locking up the renderer.
const MAX_LCS_CELLS = 4_000_000;

/** @typedef {{ artist?: string, track?: string, album?: string, duration?: number, id?: string, spotifyId?: string, source?: string, format?: string }} TrackMeta */

/**
 * Stable cache key for a track. Prefers Spotify/provider ids.
 * @param {TrackMeta} meta
 * @returns {string|null}
 */
export function cacheKey(meta) {
  if (!meta) return null;
  const id = meta.spotifyId || meta.id;
  if (id) return `id:${id}`;
  const track = norm(meta.track);
  if (!track) return null;
  const artist = norm(meta.artist);
  const dur = meta.duration != null && Number.isFinite(meta.duration)
    ? Math.round(Number(meta.duration))
    : '';
  return `t:${artist}|${track}|${dur}`;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { v: STORE_VERSION, entries: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { v: STORE_VERSION, entries: {} };
    if (parsed.v === STORE_VERSION) return { v: STORE_VERSION, entries: parsed.entries || {} };
    // Migrate rather than discard: v2 entries are real alignments, just unstamped.
    if (parsed.v === 2 && parsed.entries) {
      const entries = {};
      for (const [k, entry] of Object.entries(parsed.entries)) {
        if (!entry?.timeline?.lines?.length) continue;
        entries[k] = { ...entry, alignVersion: entry.alignVersion ?? LEGACY_ALIGN_VERSION };
      }
      return { v: STORE_VERSION, entries };
    }
    return { v: STORE_VERSION, entries: {} };
  } catch {
    return { v: STORE_VERSION, entries: {} };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota / private mode — ignore; alignment still works without cache.
  }
}

/** Compact a live timeline into JSON-safe word spans (no DOM refs). */
export function serializeTimeline(timeline) {
  if (!timeline?.lines?.length) return null;
  return {
    duration: timeline.duration,
    estimated: !!timeline.estimated,
    aligned: !!timeline.aligned,
    hasRoman: !!timeline.hasRoman,
    agents: timeline.agents?.length ? timeline.agents : undefined,
    sections: timeline.sections?.length ? timeline.sections : undefined,
    lines: timeline.lines.map((line) => ({
      start: line.start,
      end: line.end,
      agent: line.agent || undefined,
      roman: line.roman || undefined,
      english: line.english || undefined,
      translation: line.translation || undefined,
      // Human-nudged lines survive reload without freezing the rest of the song
      // as "aligned" — applyCachedTiming only locks lines marked human (or a
      // fully-aligned cache).
      human: line._humanNudged || undefined,
      words: (line.words || []).map((w) => ({
        text: w.text,
        start: w.start,
        end: w.end,
        conf: w.conf != null ? round3(w.conf) : undefined,
      })),
      bg: line.bg?.length
        ? line.bg.map((g) => ({
            start: g.start,
            end: g.end,
            words: (g.words || []).map((w) => ({ text: w.text, start: w.start, end: w.end })),
          }))
        : undefined,
    })),
  };
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Apply cached word timings onto a freshly parsed timeline.
 *
 * Fast path requires identical structure. When that fails, falls back to
 * `rebindCachedTiming` so a lyric revision doesn't throw the song away.
 * Mutates `timeline` in place. Returns true when applied.
 *
 * @param {object} timeline
 * @param {object} cached
 * @param {{ provisional?: boolean, rebind?: boolean }} [opts]
 *   `provisional` applies the spans but leaves lines unmarked, so the aligner
 *   still refines them (used for entries from an older aligner).
 */
export function applyCachedTiming(timeline, cached, opts = {}) {
  const { provisional = false, rebind = true } = opts;
  if (!timeline?.lines?.length || !cached?.lines?.length) return false;

  if (applyExactTiming(timeline, cached, provisional)) return true;
  if (!rebind) return false;
  return rebindCachedTiming(timeline, cached, { provisional });
}

/** Structure-identical fast path: same lines, same words, same text. */
function applyExactTiming(timeline, cached, provisional) {
  if (timeline.lines.length !== cached.lines.length) return false;

  const pending = [];
  for (let i = 0; i < timeline.lines.length; i++) {
    const line = timeline.lines[i];
    const src = cached.lines[i];
    if (!src?.words?.length || !line.words?.length) return false;
    if (line.words.length !== src.words.length) return false;
    // Line anchors should be close (same recording); allow small provider drift.
    if (Math.abs((line.start || 0) - (src.start || 0)) > EXACT_LINE_DRIFT_SEC) return false;

    for (let j = 0; j < line.words.length; j++) {
      const w = line.words[j];
      const sw = src.words[j];
      if (!sw || norm(w.text) !== norm(sw.text)) return false;
      pending.push([w, sw]);
    }
  }

  for (const [w, sw] of pending) {
    w.start = sw.start;
    w.end = sw.end;
    if (sw.conf != null) w.conf = sw.conf;
  }
  for (let i = 0; i < timeline.lines.length; i++) {
    const line = timeline.lines[i];
    const src = cached.lines[i];
    // Fully-aligned caches lock every line. Partial human-edit caches only lock
    // the lines the user touched, so forced alignment can still refine the rest.
    if (!provisional && (cached.aligned || src.human)) {
      line._vocalAligned = true;
      if (src.human) line._humanNudged = true;
    }
  }
  finishApply(timeline, cached, provisional);
  return true;
}

/**
 * Diff-based rebind: match the cached word sequence to the current one with an
 * LCS, give matched words their cached spans, and interpolate the rest between
 * the surrounding confident anchors by syllable weight (the same rule the
 * aligner uses for low-confidence words).
 *
 * Only lines whose words ALL matched are marked `_vocalAligned` — the edited
 * lines stay open so forced alignment re-checks exactly those.
 *
 * @returns {boolean} true when enough of the song matched to be worth applying.
 */
export function rebindCachedTiming(timeline, cached, opts = {}) {
  const { provisional = false } = opts;
  const cur = flattenWords(timeline);
  const old = flattenWords(cached);
  if (!cur.length || !old.length) return false;
  if (cur.length * old.length > MAX_LCS_CELLS) return false;

  const pairs = lcsPairs(cur.map((e) => e.key), old.map((e) => e.key));
  if (pairs.length / cur.length < MIN_REBIND_COVERAGE) return false;

  // Reject a different recording: matched anchors should sit near their line.
  const drifts = [];
  for (const [ci, oi] of pairs) {
    drifts.push(Math.abs((cur[ci].line.start || 0) - (old[oi].word.start || 0)));
  }
  if (median(drifts) > REBIND_LINE_DRIFT_SEC + maxLineSpan(timeline)) return false;

  const matched = new Array(cur.length).fill(null);
  for (const [ci, oi] of pairs) matched[ci] = old[oi].word;

  // Anchors first, so interpolation reads already-final neighbours.
  for (let i = 0; i < cur.length; i++) {
    const src = matched[i];
    if (!src) continue;
    const w = cur[i].word;
    w.start = src.start;
    w.end = src.end;
    if (src.conf != null) w.conf = src.conf;
  }
  interpolateGaps(cur, matched, timeline);

  for (let li = 0; li < timeline.lines.length; li++) {
    const line = timeline.lines[li];
    const words = line.words || [];
    if (!words.length) continue;
    // `_rebound === false` means the word kept a real cached span.
    const allMatched = words.every((w) => w._rebound === false);
    const srcHuman = !!cached.lines[li]?.human;
    if (allMatched && !provisional && (cached.aligned || srcHuman)) {
      line._vocalAligned = true;
      if (srcHuman) line._humanNudged = true;
    }
    line._rebound = !allMatched;
    for (const w of words) delete w._rebound;
  }

  finishApply(timeline, cached, provisional);
  timeline.rebound = true;
  return true;
}

/** Fill unmatched runs between anchors using syllable-weighted placement. */
function interpolateGaps(cur, matched, timeline) {
  for (const e of cur) e.word._rebound = false;

  let i = 0;
  while (i < cur.length) {
    if (matched[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < cur.length && !matched[j]) j++;
    // Gap is [i, j). Bound it by the surrounding anchors, or by the line span
    // at the edges of the song where no anchor exists.
    const prev = i > 0 ? cur[i - 1].word.end : null;
    const next = j < cur.length ? cur[j].word.start : null;
    const start = prev != null ? prev : firstLineStart(timeline, cur[i]);
    const end = next != null ? next : lastLineEnd(timeline, cur[j - 1]);
    const span = Math.max(0.001, end - start);
    const tokens = [];
    for (let k = i; k < j; k++) tokens.push(cur[k].word.text);
    const placed = wordsAcrossSpan(tokens, start, start + span);
    for (let k = i; k < j; k++) {
      const w = cur[k].word;
      const p = placed[k - i];
      if (!p) continue;
      w.start = p.start;
      w.end = p.end;
      w.conf = 0; // interpolated, not observed — the drift meter should know
      w._rebound = true;
    }
    i = j;
  }
}

function firstLineStart(timeline, entry) {
  return entry?.line?.start ?? timeline.lines[0]?.start ?? 0;
}

function lastLineEnd(timeline, entry) {
  const line = entry?.line;
  if (line?.end != null) return line.end;
  const last = timeline.lines[timeline.lines.length - 1];
  return last?.end ?? (timeline.duration || 0);
}

function maxLineSpan(timeline) {
  let max = 0;
  for (const l of timeline.lines || []) {
    const span = (l.end || 0) - (l.start || 0);
    if (span > max) max = span;
  }
  return max;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Flatten a timeline's words with their owning line, skipping empty tokens. */
function flattenWords(timeline) {
  const out = [];
  for (const line of timeline.lines || []) {
    for (const word of line.words || []) {
      const key = norm(word.text);
      if (!key) continue;
      out.push({ word, line, key });
    }
  }
  return out;
}

/**
 * Longest common subsequence over two token arrays.
 * @returns {Array<[number, number]>} index pairs into (a, b), ascending.
 */
export function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j]
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Shared tail of both apply paths: carry structure across and set flags. */
function finishApply(timeline, cached, provisional) {
  if (cached.agents?.length && !timeline.agents?.length) timeline.agents = cached.agents;
  if (cached.sections?.length && !timeline.sections?.length) timeline.sections = cached.sections;
  if (provisional) {
    timeline.provisional = true;
    return;
  }
  // Fully-aligned caches stay aligned. Partial human-edit caches only lock the
  // lines marked `_vocalAligned` above — recompute so CTC can still refine the rest.
  if (cached.aligned) {
    timeline.aligned = true;
  } else {
    const eligible = timeline.lines.filter((l) => (l.words?.length || 0) > 0);
    timeline.aligned = eligible.length > 0 && eligible.every((l) => l._vocalAligned);
    if (eligible.some((l) => l._humanNudged)) timeline.humanEdited = true;
  }
}

/**
 * @param {string} key
 * @returns {{ timeline: object, meta?: object, savedAt: number, alignVersion: number, stale: boolean }|null}
 */
export function getCachedTimeline(key) {
  if (!key || typeof localStorage === 'undefined') return null;
  const store = loadStore();
  const entry = store.entries[key];
  if (!entry?.timeline?.lines?.length) return null;
  const alignVersion = entry.alignVersion ?? LEGACY_ALIGN_VERSION;
  return { ...entry, alignVersion, stale: alignVersion < ALIGN_VERSION };
}

/** Save an aligned (or human-edited) timeline under `key`. */
export function putCachedTimeline(key, timeline, meta = {}) {
  if (!key || typeof localStorage === 'undefined') return false;
  // Full CTC pass sets `aligned`; a human nudge alone sets `humanEdited` so a
  // single corrected word still survives reload without requiring the whole song
  // to be force-aligned first.
  if (!timeline?.aligned && !timeline?.humanEdited) return false;
  const serialized = serializeTimeline(timeline);
  if (!serialized) return false;

  const store = loadStore();
  store.entries[key] = {
    savedAt: Date.now(),
    alignVersion: ALIGN_VERSION,
    meta: {
      artist: meta.artist,
      track: meta.track,
      duration: meta.duration,
      format: meta.format,
      source: meta.source,
    },
    timeline: serialized,
  };

  // Evict oldest when over cap.
  const keys = Object.keys(store.entries);
  if (keys.length > MAX_ENTRIES) {
    keys
      .map((k) => ({ k, t: store.entries[k].savedAt || 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(({ k }) => {
        delete store.entries[k];
      });
  }

  saveStore(store);
  return true;
}

/* --------------------------------------------------- sidecar import/export */

const MAX_IMPORT_LINES = 5000;
const MAX_IMPORT_WORDS = 300;
const MAX_TEXT_LEN = 400;

function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function cleanWord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT_LEN) : null;
  const start = finite(raw.start);
  if (text == null || start == null) return null;
  const end = finite(raw.end);
  const word = { text, start, end: end != null ? end : start };
  const conf = finite(raw.conf);
  if (conf != null) word.conf = conf;
  return word;
}

function cleanText(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.slice(0, MAX_TEXT_LEN * 4) : undefined;
}

/**
 * Structurally validate a timeline that came from OUTSIDE this browser (a
 * sidecar file, possibly written on another machine or hand-edited). Returns a
 * whitelisted copy, or null when it isn't a usable timeline.
 */
export function sanitizeCachedTimeline(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lines)) return null;
  if (!raw.lines.length || raw.lines.length > MAX_IMPORT_LINES) return null;

  const lines = [];
  for (const rawLine of raw.lines) {
    if (!rawLine || typeof rawLine !== 'object') return null;
    const start = finite(rawLine.start);
    if (start == null) return null;
    const rawWords = Array.isArray(rawLine.words) ? rawLine.words : [];
    if (rawWords.length > MAX_IMPORT_WORDS) return null;

    const words = [];
    for (const rw of rawWords) {
      const w = cleanWord(rw);
      if (!w) return null;
      words.push(w);
    }
    const end = finite(rawLine.end);
    const line = {
      start,
      end: end != null ? end : words.length ? words[words.length - 1].end : start,
      words,
    };
    const agent = cleanText(rawLine.agent);
    if (agent) line.agent = agent;
    const roman = cleanText(rawLine.roman);
    if (roman) line.roman = roman;
    const english = cleanText(rawLine.english);
    if (english) line.english = english;
    const translation = cleanText(rawLine.translation);
    if (translation) line.translation = translation;
    if (rawLine.human) line.human = true;

    if (Array.isArray(rawLine.bg) && rawLine.bg.length) {
      const bg = [];
      for (const g of rawLine.bg.slice(0, MAX_IMPORT_WORDS)) {
        const gWords = (Array.isArray(g?.words) ? g.words : []).map(cleanWord).filter(Boolean);
        if (!gWords.length) continue;
        bg.push({
          start: finite(g.start) ?? gWords[0].start,
          end: finite(g.end) ?? gWords[gWords.length - 1].end,
          words: gWords,
        });
      }
      if (bg.length) line.bg = bg;
    }
    lines.push(line);
  }

  const out = { lines, duration: finite(raw.duration) ?? lines[lines.length - 1].end };
  if (raw.aligned) out.aligned = true;
  if (raw.estimated) out.estimated = true;
  if (raw.hasRoman) out.hasRoman = true;
  if (Array.isArray(raw.agents) && raw.agents.length) {
    out.agents = raw.agents
      .filter((a) => a && typeof a === 'object' && cleanText(a.id))
      .slice(0, 64)
      .map((a) => ({ id: cleanText(a.id), name: cleanText(a.name), type: cleanText(a.type) }));
  }
  if (Array.isArray(raw.sections) && raw.sections.length) {
    out.sections = raw.sections
      .filter((s) => s && typeof s === 'object' && cleanText(s.part) && finite(s.start) != null)
      .slice(0, 256)
      .map((s) => ({ part: cleanText(s.part), start: finite(s.start), end: finite(s.end) ?? 0 }));
  }
  return out;
}

/**
 * Merge an externally-sourced entry (a sidecar) into the local store. Keeps
 * whatever is better: a newer aligner wins, then a newer save. Returns true
 * when the store changed.
 *
 * @param {string} key
 * @param {{ timeline: object, meta?: object, alignVersion?: number, savedAt?: number }} entry
 */
export function importEntry(key, entry) {
  if (!key || typeof localStorage === 'undefined') return false;
  const timeline = sanitizeCachedTimeline(entry?.timeline);
  if (!timeline) return false;

  const alignVersion = Number.isFinite(entry?.alignVersion)
    ? Number(entry.alignVersion)
    : LEGACY_ALIGN_VERSION;
  const savedAt = Number.isFinite(entry?.savedAt) ? Number(entry.savedAt) : 0;

  const store = loadStore();
  const existing = store.entries[key];
  if (existing?.timeline?.lines?.length) {
    const mineVersion = existing.alignVersion ?? LEGACY_ALIGN_VERSION;
    if (mineVersion > alignVersion) return false;
    if (mineVersion === alignVersion && (existing.savedAt || 0) >= savedAt) return false;
  }

  store.entries[key] = {
    savedAt: savedAt || Date.now(),
    alignVersion,
    meta: entry?.meta && typeof entry.meta === 'object' ? entry.meta : {},
    timeline,
  };
  saveStore(store);
  return true;
}

/** The raw stored entry for `key`, shaped for writing to a sidecar. */
export function exportEntry(key) {
  const entry = getCachedTimeline(key);
  if (!entry) return null;
  return {
    key,
    alignVersion: entry.alignVersion,
    savedAt: entry.savedAt,
    meta: entry.meta || {},
    timeline: entry.timeline,
  };
}

export { ALIGN_VERSION, STORE_VERSION };
