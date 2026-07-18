# Lyric sync & karaoke — engineering handoff

The living map of how lyrics get their timing and how the display sings them.
Companion doc: `alignment-accuracy-roadmap.md` (vocal-separation deep dive).

---

## 1. Pipeline at a glance

```
lyrics source ──► timeline (lines[] · words[] with start/end) ──► forced align ──► Display
  (providers)        (formats/*)         (word timing)         (align.js, Electron)   (karaoke UI)
```

- **Sources** (`app/providers/lyrics/index.js`, `fetchCatalogLyrics`): parallel
  NetEase / Musixmatch / LRCLIB, ranked richest-first by `preferResult` with a
  duration guard (won't accept a wrong-length take). Falls back to plain text →
  AI transcription (`transcript.js`, Electron Whisper).
- **Word timing tiers** (this is the whole ballgame):
  1. **True word-level** — NetEase `yrc`, Musixmatch `richsync` (`WORD_SYNC_FORMATS`).
     Real per-word onsets. Best case.
  2. **Line-level LRC** (LRCLIB) / **estimated** (plain) / **ASR** — only line (or
     no) timing; words are *estimated*.
  3. **Forced alignment** upgrades tiers 2 → effectively word-level from the audio.

## 2. Word-timing estimate (when not true word-level)

`wordsAcrossSpan` (`app/providers/formats/estimate.js`) — shared by lrc.js,
estimate.js, asr-timeline.js. **Root fix of the original "can't keep up on tempo"
bug:** the old even syllable-spread was tempo-blind (measured median 394 ms / p90
1.6 s error vs real yrc). Now it **onset-packs** words at a natural rate
(`NATURAL_SYLL_PER_SEC=4`, `STRETCH_BLEND=0.3`) and lets the last word hold the
leftover tail → median 314 ms, worst case 10 s→5.6 s. Tunable; validated by
`scratchpad/spread-error.mjs` against yrc ground truth.

## 3. Forced alignment (Electron only)

`app/align.js` `refineTimelineWithAudio` (whole local file) & `refineTimelineFromMic`
(live vinyl/stream). Renderer decodes audio → sends PCM windows over IPC →
`electron/align.cjs` runs a CTC model (`wav2vec2-base-960h`, per-line windows) →
`app/lib/forced-align.mjs` does the trellis/backtrack. Progressive/batched so early
lines sharpen first; soft-fails to keep existing timing.

**Accuracy refinements in `applyWordSpans`** (all reuse CTC output):
- **Line re-anchoring** — trust the first confident vocal onset over the catalog's
  `line.start` (wider `ALIGN_SEARCH_PAD_SEC=0.6`, bounded by prev line end).
- **Confidence interpolation** — words below `MIN_WORD_SCORE` are placed *between*
  confident anchors by syllable weight, not dropped to a guess.
- **Onset snapping** (`snapToVocalOnset`) — nudge each start to the nearest energy
  rise. Conservative on the mix; aggressive params on a clean stem.
- Writes `word.score` (anchor = CTC, interpolated = 0) and `line.uncertain`
  (`_alignCoverage < UNCERTAIN_COVERAGE=0.6`) — consumed by the display (§5, §6).

## 4. Vocal separation (opt-in, biggest accuracy lever)

MDX-Net via `onnxruntime-node` (no Python). `lib/stft.mjs` (arbitrary-N FFT +
STFT/iSTFT, tested), `lib/mdx.mjs` (tensor pack/unpack, tested),
`electron/separate.cjs` (chunked overlap-add, soft-fail→null). Config via env
`SEPARATE_MODEL_PATH`/`_URL`/`_PARAMS` (see `.env.example`). Recommended model
**UVR-MDX-NET-Voc_FT** (`{nFft:6144,hop:1024,dimF:3072,dimT:256}`) — integration
**validated against the real model** (correct tensor shapes, instrumental → near
silence). When configured: `refineTimelineWithAudio` aligns on the isolated vocal
(cleaner CTC) and computes a vocal-activity map (§6). In-app toggle in the Sync
menu (`#vocal-isolation-row`, shown only when a model is configured). Ear-check a
model before enabling: `node scripts/separate-check.mjs song.wav out.wav model.onnx`.

## 5. The karaoke display (`app/display.js`)

Reads only `clock.now()` + word start/end — never invents timing. Two timebases:
`tAudio = clock.now() + syncOffset` (true sync; used for the instrumental check),
and `t = tAudio + singerLead` (cue time; highlights run slightly ahead so the eye
leads the voice — display-only, separate from `syncOffset` latency).

Singer aids (all pure, unit-tested helpers exported from display.js):
- **Wipe** — `wipeProgress` → CSS `--wipe`, word fills left→right as sung.
- **Phases** — `wordPhase`: upcoming → **leadin** (`wordLeadIn`, longer for hard
  multi-syllable/held words) → current → sung.
- **Count-in** — `countInState` + `_showCountIn`: 3-2-1 runway + progress bar
  before a line after a real gap/intro (`countInWindowForGap`).
- **Next-line peek** (`_setPeek`/`.next`) + **prep** (strengthen first `PREP_WORDS`
  in the last `PREP_WINDOW`s) + **breath gap** (`inBreathGap`/`_setBreath`).
- **Emphasis** — `syllableGlow` (`--glow`), `attackAmount` (`--attack` punch at
  onset), `holdAmount` (`--hold` lift on long notes), `cutAmount`/`wipeWithCut`
  (`--cut`, snap tight follow-ons).
- **Confidence dim** — `confidenceDim` (uses `word.score`, `LOW_CONF_SCORE=0.35`)
  → `--soft`/`.soft`: low-confidence words drop the sweep to a gentle glow. This is
  how §3's `line.uncertain` / per-word scores surface — honest about what CTC knew.
- **Focus mode** (`setFocusMode`, TV), **reduced-motion** honored throughout.

## 6. Real-time self-assessment ("does it know it's on time?")

Three features — the app's honesty layer:

1. **Instrumental detection** — `_frame` picks:
   - stem present → `vocalStateAt(vocalIntervals)` (precise; `computeVocalIntervals`
     thresholds stem energy);
   - else if `wordSync` → assume active (**gate**: a real yrc held note must not be
     inferred as a gap);
   - else → `lyricGapStateAt(lines)` (timeline-only: a word is "sung" ~`maxHold`s
     past onset; a long leftover/intro/outro reads instrumental).
   Drives `#lyrics.instrumental` (dim) + `#instrumental-indicator` (♪ + "next line
   in Ns"), and suppresses the parked highlight.
2. **Confidence degradation** — `line.uncertain` (§3) → whole-line highlight instead
   of a jittery false word sweep. Works on any aligned song, stem or not.
3. **Drift meter** — `driftReadout` (`app/sync-learn.js`): residual = the aligner's
   smoothed measured drift (`syncEstimator.value`) − applied `syncOffset`. `>0` late,
   `<0` early, within `tolSec` in sync. Surfaces as the now-bar `#drift-chip`
   (silent until locked, then green "in sync" / amber "late"/"early") and the
   sync-panel `#drift-readout`. Only live when capture runs (vinyl/stream); idle for
   exact-clock local files. `renderDrift` in app.js, from `updateTimingReadout`.

Related: `syncLockState` → the `#sync-lock` chip (listening/converging/locked) and
the auto-timing loop (`ingestTimingSamples` folds mic-measured latency into
`SyncEstimator`, auto-nudges `syncOffset` when confident).

## 7. Clocks (`app/clock.js`)

`MediaClock` (exact, local file `<audio>`), `PredictiveClock` (vinyl, drift-corrected
rate), `StreamingClock` (Spotify/Apple, eases toward polls, deadband/jump bands),
`PassiveClock` (overlay). Display is agnostic — swap the clock, same UI.

## 8. Testing & tooling

`npm test` (node:test) — pure helpers are heavily covered: `test/display.test.js`
(karaoke helpers), `test/vocal-activity.test.js` (instrumental), `test/align-file.test.js`
(alignment/confidence/separation gating), `test/sync-learn.test.js` (drift/lock),
`test/stft.test.js` + `test/mdx.test.js` (DSP round-trips), `test/wav.test.js`
(decode/encode). Electron-only paths (CTC, separation) soft-fail and are validated
by scratchpad scripts, not the app-in-browser.

## 9. Open items

- `lyricGapStateAt` params (`maxHoldSec`/`minGapSec`) are heuristic — revisit if
  instrumental flips feel early/late on real songs.
- Vocal separation is validated but the audio-QUALITY ear-check on a real mixed
  song is the user's step before relying on it.
- Drift meter is idle for local-file exact-clock (no continuous samples) — a
  loopback-capture mode could give it a live signal there too.

**Closed:** the mic-capture path (`refineTimelineFromMic`, both batch + fallback)
now routes through the same `applyWordSpans` as the whole-file path — line
re-anchoring, confidence interpolation, onset-snap, `word.score` + `line.uncertain`
— with matched `ALIGN_SEARCH_PAD_SEC` window + `searchPad` (no double-padding). The
timing-measurement (`firstSpan` → `SyncEstimator`) still runs first, unchanged.
