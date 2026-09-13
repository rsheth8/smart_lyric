// The cinematic display: renders a lyric timeline and drives the word-by-word
// highlight from a clock. It's deliberately dumb about WHERE time comes from —
// it just calls clock.now() each frame. Same engine, any clock.
//
// Singer aids (wipe, lead-in, count-in, next-line peek, duration/syllable cues,
// breath gaps) are display-only — they read word.start/end and never invent
// timing the aligner didn't provide.

import { lyricGapStateAt, vocalStateAt, instrumentalState } from './align.js';
import { syllableCount } from './providers/formats/lrc.js';

// How early a word lights up so a first-time singer can react and start on time.
export const LEADIN_WORD = 0.32;
// The line's first word already gets the whole line's entrance (peek → prep →
// count-in) as its cue, so the full word lead-in stacked on top of SINGER_LEAD
// reads as firing early. Trim it — mid-line words keep the full lead.
export const FIRST_WORD_LEAD_SCALE = 0.45;
// Count-in runway length before a line with a real gap.
export const LEADIN_LINE = 3.0;
// Minimum inter-line gap (sec) before we show count-in / breath cues.
export const BREATH_GAP = 0.9;
export const COUNTIN_GAP = 1.2;
// Display-only singer lead (sec). Separate from syncOffset (true latency).
// Highlights/wipe run this far ahead so the cue arrives when the singer needs it.
export const SINGER_LEAD = 0.12;
// Onset attack window — punch at word.start, then settle into the wipe.
export const ATTACK_WINDOW = 0.055;
// Upcoming-line prep: strengthen the first few words in the last second.
export const PREP_WINDOW = 1.0;
export const PREP_WORDS = 3;
// Per-word CTC below this → soften/disable the karaoke wipe (honest uncertainty).
export const LOW_CONF_SCORE = 0.35;
export const SINGER_LEAD_MIN = 0;
export const SINGER_LEAD_MAX = 0.25;
const SINGER_LEAD_KEY = 'bar4bar.singerLead';
const FOCUS_KEY = 'bar4bar.focusMode';
const PARTY_KEY = 'bar4bar.partyMode';

/**
 * Party mode duet split: 0/1 singer per line. The mic passes at a real breath
 * (gap ≥ gapSec) or after maxLines in one turn, so handoffs land between phrases.
 * ponytail: gap heuristic, not verse/chorus structure — good enough to take turns.
 */
export function assignSingers(lines, { gapSec = 2.5, maxLines = 4 } = {}) {
  let singer = 0;
  let run = 0;
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    if (prev && (line.start - prev.end >= gapSec || run >= maxLines)) {
      singer = 1 - singer;
      run = 0;
    }
    run++;
    return singer;
  });
}

// Vertical translate that brings a line's center to the viewport center.
// `lineTop` must be measured relative to the scrolling #lyrics element.
export function centerTranslate(viewportH, lineTop, lineHeight) {
  return Math.round(viewportH / 2 - (lineTop + lineHeight / 2));
}

/** 0..1 progress through a word's sung span (karaoke wipe). */
export function wipeProgress(t, start, end) {
  const dur = end - start;
  if (!(dur > 0)) return t >= end ? 1 : 0;
  return Math.min(1, Math.max(0, (t - start) / dur));
}

/**
 * Discrete word phase for class toggles.
 * @returns {'upcoming'|'leadin'|'current'|'sung'}
 */
export function wordPhase(t, start, end, leadin = LEADIN_WORD) {
  if (t >= end) return 'sung';
  if (t >= start) return 'current';
  if (t >= start - leadin) return 'leadin';
  return 'upcoming';
}

/** 0..1 how "held" a word feels — longer notes lift more. */
export function holdAmount(dur) {
  return Math.min(1, Math.max(0, (dur - 0.25) / 0.9));
}

/**
 * Soft syllable emphasis 0..1 — peaks at each syllable boundary across the word.
 * Single-syllable / very short words return 0.
 */
export function syllableGlow(t, start, end, syll) {
  const n = Math.max(1, syll | 0);
  const dur = end - start;
  if (n < 2 || !(dur >= 0.45)) return 0;
  if (t < start || t > end) return 0;
  const sp = ((t - start) / dur) * n;
  const dist = Math.abs(sp - Math.round(sp));
  return Math.max(0, 1 - dist * 2.5);
}

/** 1→0 punch right at word onset (ear locks to attacks). */
export function attackAmount(t, start, window = ATTACK_WINDOW) {
  if (!(window > 0) || t < start) return 0;
  const u = (t - start) / window;
  if (u >= 1) return 0;
  return 1 - u;
}

/**
 * 0..1 "cut" urgency from gap to the next word. Tight follow-ons snap; held
 * tails with space after stay open.
 */
export function cutAmount(gapToNext) {
  if (!Number.isFinite(gapToNext) || gapToNext > 0.35) return 0;
  if (gapToNext < 0) return 1;
  return Math.min(1, Math.max(0, (0.35 - gapToNext) / 0.35));
}

/** Ease the wipe forward when the next word is tight (don't drag the tail). */
export function wipeWithCut(wipe, cut) {
  const w = Math.min(1, Math.max(0, wipe));
  const c = Math.min(1, Math.max(0, cut));
  if (c <= 0) return w;
  return Math.pow(w, 1 - 0.45 * c);
}

/**
 * Longer lead-in for multi-syllable / held words so hard entrances aren't late.
 * Easy monosyllables keep the base cue.
 */
export function wordLeadIn(word, base = LEADIN_WORD) {
  const syll = Math.max(1, word?.syll || syllableCount(word?.text || ''));
  const dur = Math.max(0, (word?.end ?? 0) - (word?.start ?? 0));
  let lead = base;
  if (syll >= 3) lead += 0.12;
  else if (syll >= 2) lead += 0.06;
  if (dur >= 0.7) lead += 0.08;
  return Math.min(0.55, lead);
}

/**
 * 0..1 how much to soften the wipe. `score == null` means catalog/estimate — trust it.
 * Interpolated / low CTC scores dim toward a gentle line-level glow.
 */
export function confidenceDim(word, floor = LOW_CONF_SCORE) {
  if (word?.score == null || !Number.isFinite(word.score)) return 0;
  if (word.score >= floor) return 0;
  if (word.score <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - word.score / floor));
}

/**
 * Count-in runway length from the gap before a line. Long instrumentals / intros
 * get a longer "get ready" than short breaths between lines.
 */
export function countInWindowForGap(gapSec) {
  const g = Number(gapSec);
  if (!Number.isFinite(g) || g <= 0) return 5.0;
  if (g >= 10) return 5.5;
  if (g >= 6) return 4.5;
  if (g >= 3.5) return 3.8;
  return LEADIN_LINE;
}

/**
 * Which lyric line should be active at cue time `t`.
 *
 * Catalog timestamps alone promote the newest line whose start has passed —
 * even while the singer is still holding the previous phrase across a gap.
 * When we know the vocal is quiet, hold the previous line through that gap and
 * advance only once singing resumes (or when lines are continuous / no vocal
 * map is available).
 *
 * @param {Array<{start:number}>} lines
 * @param {number} t  cue time (clock + sync + singer lead)
 * @param {{ prevLi?: number, vocalActive?: boolean }} [opts]
 *   `vocalActive` false = detected quiet/gap; true/unknown = allow immediate advance.
 */
export function resolveActiveLine(lines, t, { prevLi = -1, vocalActive = true } = {}) {
  let catalogLi = -1;
  if (!lines?.length || !Number.isFinite(t)) return -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start) catalogLi = i;
    else break;
  }
  if (catalogLi <= prevLi) return catalogLi;
  // Catalog wants to advance. Hold through a detected quiet gap.
  if (!vocalActive && prevLi >= 0) return prevLi;
  return catalogLi;
}

/**
 * Count-in toward the next line that hasn't started, only when there's a real
 * gap (or the song intro). Returns null when the cue shouldn't show.
 */
export function countInState(lines, t, activeLi, {
  window: windowOpt,
  minGap = COUNTIN_GAP,
} = {}) {
  const idx = activeLi < 0 ? 0 : activeLi + 1;
  if (!lines?.length || idx >= lines.length) return null;
  const line = lines[idx];
  const until = line.start - t;
  if (!(until > 0)) return null;
  // Still mid-phrase on the active line → don't overlay a count-in.
  if (activeLi >= 0 && t < lines[activeLi].end - 0.12) return null;
  const prevEnd = idx > 0 ? lines[idx - 1].end : 0;
  const gap = line.start - prevEnd;
  if (idx > 0 && gap < minGap) return null;
  const window = windowOpt ?? countInWindowForGap(idx === 0 ? line.start : gap);
  if (until > window) return null;
  return {
    idx,
    until,
    progress: 1 - until / window,
    beat: Math.max(1, Math.ceil(Math.min(until, 3))),
    window,
    gap,
  };
}

export function clampSingerLead(sec) {
  const n = Math.round(Number(sec) * 1000) / 1000;
  if (!Number.isFinite(n)) return SINGER_LEAD;
  return Math.max(SINGER_LEAD_MIN, Math.min(SINGER_LEAD_MAX, n));
}

function loadSingerLead() {
  try {
    const v = parseFloat(localStorage.getItem(SINGER_LEAD_KEY));
    return Number.isFinite(v) ? clampSingerLead(v) : SINGER_LEAD;
  } catch {
    return SINGER_LEAD;
  }
}

function saveSingerLead(v) {
  try {
    localStorage.setItem(SINGER_LEAD_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function loadFocusMode() {
  try {
    return localStorage.getItem(FOCUS_KEY) === 'on';
  } catch {
    return false;
  }
}

/** True when we're in a breathable gap approaching `lineIdx`. */
export function inBreathGap(lines, t, lineIdx, minGap = BREATH_GAP) {
  if (!lines?.length || lineIdx <= 0 || lineIdx >= lines.length) return false;
  const line = lines[lineIdx];
  const prev = lines[lineIdx - 1];
  const gap = line.start - prev.end;
  if (gap < minGap) return false;
  return t >= prev.end && t < line.start;
}

const SYNC_KEY = 'sl_sync_offset';
function loadSyncOffset() {
  try {
    const v = parseFloat(localStorage.getItem(SYNC_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function saveSyncOffset(v) {
  try {
    localStorage.setItem(SYNC_KEY, String(v));
  } catch {
    /* ignore */
  }
}

export class Display {
  constructor({ stage, lyricsEl, bgCanvas }) {
    this.stage = stage;
    this.lyricsEl = lyricsEl;
    this.bg = bgCanvas;
    this.bx = bgCanvas.getContext('2d');
    this.clock = null;
    this.lines = [];
    this.lineEls = [];
    this.activeLine = -1;
    this._instrState = { on: false, quietSince: null };
    this.raf = null;
    // Manual fine-tune (seconds). Positive = lyrics lead (show earlier), which
    // counters output/network lag so highlighting lands on the beat. Starting
    // value comes from the legacy global key; app.js replaces it with the
    // per-song / device-default resolver on each track load.
    this.syncOffset = loadSyncOffset();
    this.syncOffsetSource = 'legacy'; // 'track' | 'device' | 'zero' | 'legacy' | 'manual'
    // Album-art-derived palette (RGB triplets). Sensible default until we have art.
    this.palette = [[227, 194, 122], [255, 113, 91], [58, 44, 23]];
    // Singer-aid animation state (karaoke wipe + syllable glow).
    this._curWordEl = null;
    this._peekLine = -1;
    this._breathLine = -1;
    this._ciEl = null;
    this._ciFill = null;
    this._ciNum = null;
    this._lockEl = null;
    this._lockState = '';
    // Display-only; does not change syncOffset / aligner measurements.
    this.singerLead = loadSingerLead();
    this.focusMode = false;
    try {
      this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this._reduceMotion = false;
    }
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
    if (loadFocusMode()) this.setFocusMode(true);
    this.partyMode = false;
    try {
      if (localStorage.getItem(PARTY_KEY) === 'on') this.setPartyMode(true, { persist: false });
    } catch {
      /* ignore */
    }
  }

  /** Two singers take turns: alternate line colours + "you're up" in breaks. */
  setPartyMode(on, { persist = true } = {}) {
    this.partyMode = !!on;
    this.stage?.classList.toggle('party', this.partyMode);
    if (persist) {
      try {
        localStorage.setItem(PARTY_KEY, this.partyMode ? 'on' : 'off');
      } catch {
        /* ignore */
      }
    }
    return this.partyMode;
  }

  togglePartyMode() {
    return this.setPartyMode(!this.partyMode);
  }

  // Whose turn the upcoming line is, for the break / count-in cue. '' outside party mode.
  _turnLabel(idx) {
    const line = this.partyMode ? this.lines[idx] : null;
    return line ? `Singer ${line.singer + 1} · you're up` : '';
  }

  setSingerLead(sec, { persist = true } = {}) {
    this.singerLead = clampSingerLead(sec);
    if (persist) saveSingerLead(this.singerLead);
    return this.singerLead;
  }

  /** TV-friendly: only active + next line, chrome out of the way. */
  setFocusMode(on, { persist = true } = {}) {
    this.focusMode = !!on;
    this.stage?.classList.toggle('focus-mode', this.focusMode);
    if (persist) {
      try {
        localStorage.setItem(FOCUS_KEY, this.focusMode ? 'on' : 'off');
      } catch {
        /* ignore */
      }
    }
    return this.focusMode;
  }

  toggleFocusMode() {
    return this.setFocusMode(!this.focusMode);
  }

  setClock(clock) {
    this.clock = clock;
  }

  /** Singer-cue playhead (s) the highlight follows, as in _frame; null without a clock. */
  cueTime() {
    if (!this.clock) return null;
    return this.clock.now() + this.syncOffset + (this._reduceMotion ? 0 : this.singerLead || 0);
  }

  setPalette(colors) {
    if (colors && colors.length) this.palette = colors;
  }

  // Nudge the manual sync offset (seconds) and persist. Returns the new value.
  // Positive = lyrics earlier (lead); negative = lyrics later (lag).
  // `onPersist(offset)` lets the app also store per-track / device defaults.
  nudgeSyncOffset(deltaSec, onPersist) {
    this.syncOffset = Math.round((this.syncOffset + deltaSec) * 1000) / 1000;
    this.syncOffset = Math.max(-2, Math.min(2, this.syncOffset));
    this.syncOffsetSource = 'manual';
    saveSyncOffset(this.syncOffset);
    onPersist?.(this.syncOffset);
    return this.syncOffset;
  }

  setSyncOffset(sec, { source = 'manual', persistLegacy = true } = {}) {
    this.syncOffset = Math.max(-2, Math.min(2, Math.round(Number(sec) * 1000) / 1000 || 0));
    this.syncOffsetSource = source;
    if (persistLegacy) saveSyncOffset(this.syncOffset);
    return this.syncOffset;
  }

  resetSyncOffset(onPersist) {
    this.syncOffset = 0;
    this.syncOffsetSource = 'zero';
    saveSyncOffset(0);
    onPersist?.(0);
    return 0;
  }

  // Build DOM from a parsed timeline. Each line gets an original text row plus a
  // `.line-sub` row for the language aid (romanization or English), populated by
  // setAidMode(). Line objects may carry `.roman` / `.english` overlay strings.
  setLyrics(timeline, { source, format, wordSync, aligned } = {}) {
    this.lines = timeline.lines || [];
    this.lyricsEl.innerHTML = '';
    const singers = assignSingers(this.lines);
    this.lineEls = this.lines.map((line, li) => {
      const el = document.createElement('div');
      el.className = 'line';
      line.singer = singers[li];
      el.dataset.singer = String(line.singer);
      // Alignment wasn't confident of the per-word timing here → the display shows
      // this line at line level (whole-line highlight) rather than a false sweep.
      if (line.uncertain) el.classList.add('uncertain');
      const orig = document.createElement('div');
      orig.className = 'line-orig';
      const n = line.words.length;
      line.words.forEach((word, wi) => {
        const s = document.createElement('span');
        s.className = 'word';
        // Phrase coaching: entrances + endings matter most for first-time singers.
        if (wi === 0) s.classList.add('phrase-head');
        if (wi === n - 1) s.classList.add('phrase-tail');
        s.textContent = word.text;
        orig.appendChild(s);
        word.el = s;
        // Cache syllable count so the per-syllable glow doesn't recompute every frame.
        word.syll = Math.max(1, syllableCount(word.text));
      });
      el.appendChild(orig);
      const sub = document.createElement('div');
      sub.className = 'line-sub';
      el.appendChild(sub);
      line.subEl = sub;
      this.lyricsEl.appendChild(el);
      line.el = el;
      return el;
    });
    this.aidMode = 'off';
    this.lyricsEl.classList.remove('show-sub');
    this.estimated = !!timeline.estimated;
    // Vocal-activity map (from stem separation). When absent, display falls back
    // to lyric-gap inference so long instrumental bridges still show the ♪ state.
    this.vocalIntervals = timeline.vocalIntervals || null;
    // True per-word timing (yrc/richsync): a long word is a real held note, so the
    // lyric-gap heuristic must NOT run on it (it would false-flag sustains as
    // instrumental). Only the stem's vocal map is trustworthy for these.
    this.wordSync = !!wordSync;
    this._setInstrumental(false);
    this._hideCountIn();
    this._applyCurrentWord(null);
    this._setPeek(-1);
    this._setBreath(-1);
    this._setBadge(this._timingBadge({ estimated: this.estimated, source, format, wordSync, aligned }));
    this.activeLine = -1;
    this._instrState = { on: false, quietSince: null };
    this._resize();
  }

  /** Which aid overlays have any content on the current timeline. */
  aidAvailability() {
    return {
      roman: this.lines.some((l) => l.roman),
      english: this.lines.some((l) => l.english),
    };
  }

  // Show a language aid under each line: 'off' | 'roman' | 'english'.
  setAidMode(mode) {
    this.aidMode = mode;
    const on = mode !== 'off';
    for (const line of this.lines) {
      if (line.subEl) line.subEl.textContent = on ? line[mode] || '' : '';
    }
    this.lyricsEl.classList.toggle('show-sub', on);
    if (!this.readingMode && this.activeLine >= 0) this._centerOn(Math.max(0, this.activeLine));
  }

  // Re-apply the current mode (e.g. after English lines are filled in lazily).
  refreshAid() {
    this.setAidMode(this.aidMode || 'off');
  }

  // Small persistent label (e.g. "Estimated timing") so approximate scroll is honest.
  _timingBadge({ estimated, source, format, wordSync, aligned }) {
    if (source === 'ai-spotify' || source === 'ai-transcript' || format === 'asr') {
      return aligned ? 'AI lyrics · vocal-aligned' : 'AI lyrics · from audio';
    }
    if (estimated) return 'Estimated timing';
    if (aligned) return 'Vocal-aligned';
    if (wordSync) return `Word sync · ${source || format || 'synced'}`;
    return 'Line sync · words estimated';
  }

  _setBadge(text) {
    if (!text) {
      this._badge?.remove();
      this._badge = null;
      return;
    }
    if (!this._badge) {
      this._badge = document.createElement('div');
      this._badge.id = 'mode-badge';
      this.stage.appendChild(this._badge);
    }
    this._badge.textContent = text;
  }

  // Toggle the instrumental (no-vocal) state and update its indicator. `nextIn` is
  // seconds until the next vocal entry (for a countdown), or null.
  //
  // The countdown draws a filling bar as well as the "next line in Ns" text, so
  // the wait reads as a runway you can time your entrance against rather than a
  // number you have to watch. Progress needs a denominator the indicator itself
  // has to remember: `nextIn` only says how much is LEFT, so the first reading
  // after the ♪ appears is captured as the span the bar fills across.
  _setInstrumental(on, nextIn = null, nextIdx = -1) {
    if (on !== this._instrumental) {
      this._instrumental = on;
      this.lyricsEl.classList.toggle('instrumental', on);
      if (on && !this._instrEl) {
        this._instrEl = document.createElement('div');
        this._instrEl.id = 'instrumental-indicator';
        this._instrEl.innerHTML =
          '<span class="instr-note">♪</span>' +
          '<span class="instr-secs" aria-hidden="true"></span>' +
          '<div class="instr-track"><div class="instr-fill"></div></div>' +
          '<span class="instr-next"></span>';
        this.stage.appendChild(this._instrEl);
        this._instrFill = this._instrEl.querySelector('.instr-fill');
        this._instrSecs = this._instrEl.querySelector('.instr-secs');
        this._instrNext = this._instrEl.querySelector('.instr-next');
      }
      if (this._instrEl) this._instrEl.classList.toggle('show', on);
      // A fresh gap gets a fresh runway — never carry the last gap's span over.
      this._instrSpan = on && Number.isFinite(nextIn) && nextIn > 0 ? nextIn : null;
    }
    if (!on || !this._instrEl) return;

    const known = Number.isFinite(nextIn) && nextIn > 0;
    // A gap whose length we only learn later (or that grew) still gets an honest
    // denominator: track the largest remaining time seen for this gap.
    if (known && (this._instrSpan == null || nextIn > this._instrSpan)) this._instrSpan = nextIn;

    const turn = known ? this._turnLabel(nextIdx) : '';
    const label = turn || (known ? 'until next line' : '');
    if (this._instrNext && this._instrNext.textContent !== label) this._instrNext.textContent = label;
    this._instrEl.dataset.singer = turn ? String(this.lines[nextIdx].singer) : '';

    const secsLabel = known ? String(Math.max(1, Math.ceil(nextIn))) : '';
    if (this._instrSecs && this._instrSecs.textContent !== secsLabel) {
      this._instrSecs.textContent = secsLabel;
    }

    // Unknown remaining time (outro, no next line) → no bar to fill.
    const progress = known && this._instrSpan > 0 ? 1 - nextIn / this._instrSpan : 0;
    const pct = `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%`;
    this._instrEl.classList.toggle('counting', known);
    if (this._instrFill && this._instrFill.style.width !== pct) this._instrFill.style.width = pct;
  }

  /**
   * Hide every transient playback overlay. Called when leaving a song — these
   * live on `stage` (not `#viewport`), so the rule that fades the lyrics out in
   * setup mode never reached them and they hung over the menu.
   */
  clearOverlays() {
    this._setInstrumental(false);
    this._hideCountIn();
    this._applyCurrentWord(null);
    this._setPeek(-1);
    this._setBreath(-1);
    if (this._lockEl) this._lockEl.classList.remove('show');
    this._instrState = { on: false, quietSince: null };
  }

  /**
   * Full teardown when returning to the menu: overlays + lyric DOM + clock so
   * the RAF loop has nothing left to follow (and can't re-show ♪ / peek).
   */
  clearPlayback() {
    this.clearOverlays();
    this.clock = null;
    this.lines = [];
    this.lineEls = [];
    this.activeLine = -1;
    this.vocalIntervals = null;
    this.wordSync = false;
    if (this.lyricsEl) {
      this.lyricsEl.innerHTML = '';
      this.lyricsEl.classList.remove('instrumental', 'show-sub');
      this.lyricsEl.style.transform = '';
    }
    this._lastY = null;
  }

  _ensureCountIn() {
    if (this._ciEl) return;
    this._ciEl = document.createElement('div');
    this._ciEl.id = 'count-in';
    this._ciEl.innerHTML =
      '<span class="ci-who"></span><div class="ci-track"><div class="ci-fill"></div></div><span class="ci-num"></span>';
    this.stage.appendChild(this._ciEl);
    this._ciFill = this._ciEl.querySelector('.ci-fill');
    this._ciNum = this._ciEl.querySelector('.ci-num');
    this._ciWho = this._ciEl.querySelector('.ci-who');
  }

  _showCountIn({ progress, beat, until, idx }) {
    this._ensureCountIn();
    this._ciEl.classList.add('show');
    const who = this._turnLabel(idx);
    if (this._ciWho.textContent !== who) this._ciWho.textContent = who;
    this._ciEl.dataset.singer = who ? String(this.lines[idx].singer) : '';
    const pct = `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%`;
    if (this._ciFill && this._ciFill.style.width !== pct) this._ciFill.style.width = pct;
    // Numeric 3-2-1 only in the final three seconds; earlier just the runway.
    const label = until <= 3 ? String(beat) : '';
    if (this._ciNum && this._ciNum.textContent !== label) this._ciNum.textContent = label;
  }

  _hideCountIn() {
    if (!this._ciEl) return;
    this._ciEl.classList.remove('show');
    if (this._ciFill) this._ciFill.style.width = '0%';
    if (this._ciNum) this._ciNum.textContent = '';
  }

  _applyCurrentWord(el, { wipe = 0, hold = 0, glow = 0, cut = 0, attack = 0, soft = 0 } = {}) {
    if (this._curWordEl && this._curWordEl !== el) {
      this._curWordEl.style.removeProperty('--wipe');
      this._curWordEl.style.removeProperty('--hold');
      this._curWordEl.style.removeProperty('--glow');
      this._curWordEl.style.removeProperty('--cut');
      this._curWordEl.style.removeProperty('--attack');
      this._curWordEl.style.removeProperty('--soft');
      this._curWordEl.classList.remove('attack', 'cut', 'soft');
    }
    this._curWordEl = el || null;
    if (!el) return;
    if (this._reduceMotion) {
      el.style.setProperty('--wipe', '100%');
      el.style.setProperty('--hold', '0');
      el.style.setProperty('--glow', '0');
      el.style.setProperty('--cut', '0');
      el.style.setProperty('--attack', '0');
      el.style.setProperty('--soft', '0');
      el.classList.remove('attack', 'cut', 'soft');
      return;
    }
    // Low-confidence: freeze wipe mid-word and mark soft so CSS drops the sweep.
    const w = soft > 0.55 ? 0.5 : wipe;
    el.style.setProperty('--wipe', `${(w * 100).toFixed(1)}%`);
    el.style.setProperty('--hold', (hold * (1 - 0.7 * soft)).toFixed(3));
    el.style.setProperty('--glow', (glow * (1 - soft)).toFixed(3));
    el.style.setProperty('--cut', cut.toFixed(3));
    el.style.setProperty('--attack', (attack * (1 - soft)).toFixed(3));
    el.style.setProperty('--soft', soft.toFixed(3));
    el.classList.toggle('attack', attack > 0.05 && soft < 0.55);
    el.classList.toggle('cut', cut > 0.45 && soft < 0.55);
    el.classList.toggle('soft', soft > 0.35);
  }

  /** Quiet mic-lock chip: listening → converging → locked (or hidden). */
  setSyncLock(state) {
    const s = state || '';
    if (s === this._lockState) return;
    this._lockState = s;
    const show = s === 'listening' || s === 'converging' || s === 'locked';
    if (!show) {
      this._lockEl?.classList.remove('show');
      if (this._lockEl) this._lockEl.dataset.state = '';
      return;
    }
    if (!this._lockEl) {
      this._lockEl = document.createElement('div');
      this._lockEl.id = 'sync-lock';
      this.stage.appendChild(this._lockEl);
    }
    const label =
      s === 'locked' ? 'Sync locked' : s === 'converging' ? 'Sync converging…' : 'Sync listening…';
    if (this._lockEl.textContent !== label) this._lockEl.textContent = label;
    this._lockEl.dataset.state = s;
    this._lockEl.classList.add('show');
  }

  _setPeek(idx) {
    if (idx === this._peekLine) return;
    if (this._peekLine >= 0) this.lineEls[this._peekLine]?.classList.remove('next');
    this._peekLine = idx;
    if (idx >= 0) this.lineEls[idx]?.classList.add('next');
  }

  _setBreath(idx) {
    if (idx === this._breathLine) return;
    if (this._breathLine >= 0) this.lineEls[this._breathLine]?.classList.remove('breath');
    this._breathLine = idx;
    if (idx >= 0) this.lineEls[idx]?.classList.add('breath');
  }

  _clearLineWords(line) {
    if (!line?.words) return;
    for (const word of line.words) {
      word.el?.classList.remove('current', 'sung', 'leadin', 'prep', 'attack', 'cut', 'soft');
    }
    line.el?.classList.remove('prep-ready');
  }

  /**
   * Drive per-word classes + return the active word's wipe/hold/glow for CSS vars.
   * `wordLevel` false → honest line-level lighting (uncertain lines).
   */
  _updateLineWords(line, t, { wordLevel, allowLeadin }) {
    let currentEl = null;
    let wipe = 0;
    let hold = 0;
    let glow = 0;
    let cut = 0;
    let attack = 0;
    let soft = 0;
    if (!line?.words) return { currentEl, wipe, hold, glow, cut, attack, soft };
    const words = line.words;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const c = word.el.classList;
      c.remove('current', 'sung', 'leadin', 'attack', 'cut', 'soft');
      if (!wordLevel) continue;
      const dim = confidenceDim(word);
      if (dim > 0.35) c.add('soft');
      const lead = i === 0 ? wordLeadIn(word) * FIRST_WORD_LEAD_SCALE : wordLeadIn(word);
      const phase = wordPhase(t, word.start, word.end, lead);
      if (phase === 'sung') {
        c.add('sung');
      } else if (phase === 'current') {
        c.add('current');
        const dur = Math.max(0.05, word.end - word.start);
        const next = words[i + 1];
        const gap = next ? next.start - word.end : 0.5;
        cut = cutAmount(gap);
        wipe = wipeWithCut(wipeProgress(t, word.start, word.end), cut);
        hold = holdAmount(dur) * (1 - 0.65 * cut);
        glow = syllableGlow(t, word.start, word.end, word.syll || 1);
        attack = attackAmount(t, word.start);
        soft = dim;
        currentEl = word.el;
      } else if (phase === 'leadin' && allowLeadin) {
        c.add('leadin');
      }
    }
    return { currentEl, wipe, hold, glow, cut, attack, soft };
  }

  /** Lead-in + last-second prep strip on the upcoming line. */
  _updatePeekWords(line, t) {
    if (!line?.words) return;
    const until = line.start - t;
    const prepOn = until > 0 && until <= PREP_WINDOW;
    line.el?.classList.toggle('prep-ready', prepOn);
    line.words.forEach((word, i) => {
      const c = word.el.classList;
      c.remove('current', 'sung', 'leadin', 'prep', 'attack', 'cut', 'soft');
      if (confidenceDim(word) > 0.35) c.add('soft');
      if (wordPhase(t, word.start, word.end, wordLeadIn(word)) === 'leadin') c.add('leadin');
      if (prepOn && i < PREP_WORDS) c.add('prep');
    });
  }

  updateTimingBadge({ source, format, wordSync, aligned } = {}) {
    this._setBadge(
      this._timingBadge({ estimated: this.estimated, source, format, wordSync, aligned })
    );
  }

  // Plain reading mode: no follow, no highlight — just the full lyrics to scroll.
  // For the estimated fallback where auto-scroll may feel off. Returns new state.
  toggleReadingMode(force) {
    const on = force === undefined ? !this.readingMode : !!force;
    this.readingMode = on;
    this.lyricsEl.classList.toggle('reading', on);
    this.stage.querySelector('#viewport')?.classList.toggle('reading', on);
    if (on) {
      this.lyricsEl.style.transform = 'none';
      this._lastY = null;
      this.lineEls.forEach((el) => el.classList.remove('active', 'past', 'next', 'breath'));
      this._peekLine = -1;
      this._breathLine = -1;
      this._hideCountIn();
      this._applyCurrentWord(null);
    } else if (this.activeLine >= 0) {
      this._centerOn(Math.max(0, this.activeLine));
    }
    return on;
  }

  start() {
    if (this.raf) return;
    const loop = (t) => {
      this._frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bg.width = window.innerWidth * dpr;
    this.bg.height = window.innerHeight * dpr;
    this.bx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.activeLine >= 0) this._centerOn(this.activeLine);
  }

  _centerOn(idx) {
    const el = this.lineEls[idx];
    if (!el) return;
    const H = window.innerHeight;
    if (!H) return; // viewport not laid out yet — try again next frame
    const y = centerTranslate(H, el.offsetTop, el.offsetHeight);
    if (y !== this._lastY) {
      this.lyricsEl.style.transform = `translateY(${y}px)`;
      this._lastY = y;
    }
  }

  _frame(rafTime) {
    // Menu is up — don't follow a leftover timeline or resurrect stage overlays.
    if (this.stage?.dataset?.mode === 'setup') {
      this._drawBg(rafTime / 1000, 0);
      return;
    }
    if (!this.clock || !this.lines.length) {
      this._drawBg(rafTime / 1000, 0);
      return;
    }
    // Reading mode is a static scroll — skip all follow/highlight work.
    if (this.readingMode) {
      this._hideCountIn();
      this._applyCurrentWord(null);
      this._drawBg(rafTime / 1000, 0);
      return;
    }
    // tAudio = latency-compensated playhead (true sync). t = singer-cue time —
    // highlights run slightly ahead so the eye leads the voice.
    const tAudio = this.clock.now() + this.syncOffset;
    const lead = this._reduceMotion ? 0 : this.singerLead || 0;
    const t = tAudio + lead;

    // Instrumental / vocal activity first — line choice may hold through a gap.
    const vs = this.vocalIntervals?.length
      ? vocalStateAt(this.vocalIntervals, tAudio)
      : this.wordSync
        ? { active: true, nextVocalIn: null } // real word timing → don't infer gaps
        : lyricGapStateAt(this.lines, tAudio);

    // Which line are we on? -1 before the first line begins. Hold the current
    // line through a detected vocal gap; advance immediately on continuous lines.
    const li = resolveActiveLine(this.lines, t, {
      prevLi: this.activeLine,
      vocalActive: vs.active,
    });
    const shown = Math.max(0, li);

    if (li !== this.activeLine) {
      if (this.activeLine >= 0) this._clearLineWords(this.lines[this.activeLine]);
      this.lineEls.forEach((el, i) => {
        el.classList.toggle('active', i === li);
        el.classList.toggle('past', li >= 0 && i < li);
      });
      this.activeLine = li;
    }
    // Recompute centering every frame so it self-heals after viewport changes
    // (window resize, projector connect, or a briefly zero-height viewport).
    this._centerOn(shown);

    // Hysteretic: needs sustained quiet to appear, clears early when the vocal
    // is about to return. Keeps ♪ from stuttering on breaths / consonant dips.
    this._instrState = instrumentalState(this._instrState, {
      quiet: !vs.active,
      nextVocalIn: vs.nextVocalIn,
      t: tAudio,
    });
    const inst = this._instrState.on;

    // Count-in toward the next phrase (intro / bridge / breathy gap). Prefer this
    // over the instrumental ♪ in the final runway so the singer gets a clear "go".
    const ci = countInState(this.lines, t, li);
    if (ci && !this._reduceMotion) {
      this._setInstrumental(false);
      this._showCountIn(ci);
    } else {
      this._hideCountIn();
      this._setInstrumental(inst, inst ? vs.nextVocalIn : null, li + 1);
    }

    // Next-line peek + breath inhale on the upcoming line. Keep the peek visible
    // during count-in even if the vocal map still says "instrumental".
    const peekIdx = li + 1 < this.lines.length ? li + 1 : (li < 0 ? 0 : -1);
    const showPeek = peekIdx >= 0 && peekIdx !== li && (ci ? ci.idx === peekIdx : !inst);
    this._setPeek(showPeek ? peekIdx : -1);
    const breathIdx = peekIdx >= 0 && inBreathGap(this.lines, t, peekIdx) ? peekIdx : -1;
    this._setBreath(breathIdx);

    // Word states on the active line (+ lead-in / prep on the peeked next line).
    let cur = { currentEl: null, wipe: 0, hold: 0, glow: 0, cut: 0, attack: 0, soft: 0 };
    if (li >= 0) {
      const lineLevel = !inst && this.lines[li].uncertain;
      if (inst) {
        for (const word of this.lines[li].words) {
          const c = word.el.classList;
          c.remove('current', 'leadin', 'prep', 'attack', 'cut', 'soft');
          if (t >= word.end) c.add('sung');
          else c.remove('sung');
        }
      } else {
        cur = this._updateLineWords(this.lines[li], t, {
          wordLevel: !lineLevel,
          allowLeadin: true,
        });
      }
    }
    if (showPeek && peekIdx >= 0 && peekIdx !== li && !this.lines[peekIdx].uncertain) {
      this._updatePeekWords(this.lines[peekIdx], t);
    } else if (this._peekLine < 0 && li + 1 < this.lines.length) {
      // Peek just cleared — drop any leftover lead-in / prep on the following line.
      const nxt = this.lines[li + 1];
      if (nxt && t < nxt.start) this._clearLineWords(nxt);
    }

    this._applyCurrentWord(cur.currentEl, cur);

    const prog = this.lines.length ? shown / this.lines.length : 0;
    this._drawBg(rafTime / 1000, prog);
  }

  // Ambient album-art glow: slow-drifting radial blobs in the palette colors.
  _drawBg(time, prog) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const st = time * 0.55; // calm drift
    const bx = this.bx;
    bx.clearRect(0, 0, W, H);
    bx.fillStyle = '#0b0908';
    bx.fillRect(0, 0, W, H);
    for (let i = 0; i < this.palette.length; i++) {
      const c = this.palette[i];
      const ph = st * (0.12 + i * 0.05) + i * 2.1 + prog * 3;
      const x = W * (0.5 + 0.32 * Math.sin(ph));
      const y = H * (0.5 + 0.3 * Math.cos(ph * 0.8 + i));
      const r = Math.min(W, H) * (0.55 + 0.12 * Math.sin(st * 0.5 + i));
      const g = bx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.45)`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      bx.fillStyle = g;
      bx.fillRect(0, 0, W, H);
    }
  }
}
