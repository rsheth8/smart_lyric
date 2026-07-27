# Lyric alignment accuracy — roadmap & heavy-dep scope

Status as of 2026-07-17. Word-timing accuracy has two sources: (a) catalogs that
ship true word-level timing (NetEase `yrc`, Musixmatch `richsync`), and (b)
**forced alignment** of the audio for everything else (line-level LRC, estimated,
ASR). This doc covers making (b) as accurate as possible.

## Shipped

- **Tempo-aware fallback word spread** (`app/providers/formats/estimate.js`
  `wordsAcrossSpan`): onset-pack + held tail instead of even stretch. Median
  per-word error 394→314 ms vs `yrc` ground truth.
- **Always-on, progressive forced alignment for local files** (`app/align.js`
  `refineTimelineWithAudio`, Electron): batched, patches as it goes, warms the
  model on file attach, surfaces progress/errors.
- **Cheap alignment refinements** (`applyWordSpans`, `electron/align.cjs`):
  1. **Line re-anchoring** — trust the first confident vocal onset over the
     catalog's line start (wider `searchPad`, bounded by the previous line).
  2. **Confidence interpolation** — low-score words are placed *between*
     confident anchors by syllable weight, not dropped to a heuristic guess.
  3. **Onset snapping** — `snapToVocalOnset` nudges each start to the nearest
     local energy rise (conservative on a full mix; see below).

## Heavy deps (scoped, not yet built)

### 1. Vocal separation before alignment — MEASURED, 2026-07-27

**Verdict: confirmed, and it helps EVERY song. Keep it unconditional.**
Measured with `scripts/align-check.mjs --both` over the 7-song test set
(UVR-MDX-NET-Voc_FT, whole song, real CTC).

⚠️ **A first pass using LINE-LEVEL fallback % as the metric concluded
"decisive on dense mixes, no-op on sparse ones". That was wrong** — fallback %
saturates at 0 for most songs, so it cannot measure improvement that doesn't
cross the threshold. The sensitive metric is the **share of words the aligner
scores 0.7–1.0**, which is what actually drives per-word timing quality.

| Song | raw hi-conf % | stem hi-conf % | gain | raw → stem fallback |
|---|---|---|---|---|
| Nirvana — Teen Spirit | 61.7 | 86.2 | **+24.5 pp** | 14% → **0%** |
| Blow | 42.2 | 53.8 | +11.6 pp | 0% → 0% |
| 16 | 52.6 | 63.5 | +10.9 pp | 0% → 0% |
| Tum Hi Ho \* | 86.4 | 92.5 | +6.1 pp | 8% → 8% |
| Peelings \* | 37.7 | 43.2 | +5.5 pp | 0% → 0% |
| Adele — Someone Like You | 80.6 | 84.2 | +3.6 pp | 0% → 0% |
| All RED | 33.0 | 34.3 | +1.3 pp | 0% → 0% |

\* non-English, aligned via romanization through an English-only CTC model —
their absolute numbers reflect that, not mix density.

**7 of 7 songs improve.** Only Nirvana crosses the fallback threshold, which is
why the first pass mistook a universal gain for a conditional one.

Caveat: high-confidence share measures the aligner's *confidence*, not measured
error against ground truth. Higher CTC scores should mean better spans, and on
Nirvana it demonstrably removes line-level fallback, but this harness does not
compare against `yrc` ground truth.

**Do not build an adaptive "skip separation on sparse mixes" rule.** Tested with
cheap raw-mix features (`scripts/mix-features.mjs`: spectral flatness, crest,
centroid, flux, band ratios, stereo width) correlated against the per-song gain:

    ENGLISH ONLY (n=5)   centroidHz r=0.65   flatness r=0.61   crest r=0.51
                         flux r=0.14        rawTop% r=0.15

Nothing is strong enough to act on at n=5 (r=0.65 there is not significant), and
`rawTop%` r=0.15 means a weak raw-mix alignment does not even predict its own
gain — so "align first, decide after" doesn't work either. Skipping would cost
every song a little and one song a lot, to save time on a step that is paid once.

**Do not build the per-track stem cache** proposed below either: since the
durable word-timing cache landed (`docs/ttml-word-cache.md`), a replay reuses the
aligned timeline and never needs the stem, so caching stems would cost ~50 MB per
song for nothing.

Cost for the record: ~1.2x realtime (Adele: 3m30s of a 3m52s run; both
alignments together were ~20s). Paid once per song, and now durably cached.

### 1b. Original scoping notes

CTC phoneme probabilities degrade when drums/bass/instruments mask the voice, so
choruses and dense mixes align worst, and onset-snapping can catch a drum hit
instead of a syllable. Isolating the vocal stem first is how pro lyric-sync
(Musixmatch et al.) works; it typically **halves** alignment error on real mixes
and makes onset-snapping safe/aggressive.

**Options**
| Approach | Quality | Runtime fit | Notes |
|---|---|---|---|
| **MDX-Net / UVR (ONNX)** ✅ recommended | High vocal isolation | Runs via `onnxruntime-node` **already pulled in by `@huggingface/transformers`** — no Python | ~50–300 MB model; 2-stem (vocal/instrumental) is enough |
| Demucs (htdemucs) | Best | PyTorch → needs a Python sidecar or ONNX export (large) | Overkill; heavier deploy |
| open-unmix (umxhq) | Good | PyTorch/ONNX, lighter | Viable ONNX alternative to MDX |
| Spleeter | Dated | TensorFlow/Python | Avoid |

**Recommended:** a 2-stem MDX-Net ONNX model run in a new `electron/separate.cjs`
via `onnxruntime-node`, reusing the runtime the aligner already loads.

**Built so far (foundation, dormant until a model is configured):**
- `lib/stft.mjs` — arbitrary-N FFT (Bluestein; MDX's n_fft=6144 isn't a power of
  two), STFT/iSTFT with Hann + COLA. Unit-tested: FFT vs DFT, round-trip <1e-6.
- `lib/mdx.mjs` — `mixToNet` / `netToMix` pack the stereo STFT into the model's
  `[1,4,dimF,dimT]` tensor and invert it. Unit-tested via identity round-trip.
- `electron/separate.cjs` — ONNX session load/cache/warm, chunked inference with
  a cross-faded overlap-add, and a **soft-fail-to-null** contract. Config via env
  `SEPARATE_MODEL_PATH` / `SEPARATE_MODEL_URL` / `SEPARATE_MODEL_PARAMS`.
- IPC `separate-vocals` / `separate-available` / `separate-warm` (main + preload).
- Renderer seam (`app/align.js`): `vocalStemMono16k` decodes stereo@44.1k →
  `separateVocals` → downmix+resample to 16k mono; `refineTimelineWithAudio` uses
  the stem when available and **falls back to the raw mix otherwise**. Warmed on
  file attach. `separateAvailable()` is false with no model → today it's a no-op.

**Remaining to make it live (needs the real desktop app + a model):**

*Pinned model:* **UVR-MDX-NET-Voc_FT** — params `{nFft:6144, hop:1024, dimF:3072,
dimT:256}` (also fits Kim_Vocal_2). Download:
`https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx`
(Our STFT convention was cross-checked against MDX/torch: periodic Hann, reflect
center-pad, frames==dimT via `(dimT-1)*hop` samples, first dimF bins, channel
layout `[L_re, L_im, R_re, R_im]` — all match.)

1. **Ear-check first** (no Electron needed):
   ```
   ffmpeg -i song.mp3 -ac 2 -ar 44100 song.wav
   node scripts/separate-check.mjs song.wav song.vocals.wav /path/to/UVR-MDX-NET-Voc_FT.onnx
   ```
   The output WAV should be isolated vocals. A shape/dim error means params don't
   match the model — adjust `SEPARATE_MODEL_PARAMS`.
2. **Enable in-app:** set `SEPARATE_MODEL_PATH` (or `_URL`) in `.env`. Alignment
   then uses the stem automatically (falls back to raw mix if it fails). A **Sync
   menu toggle** ("Isolate the vocal before aligning") appears once a model is
   configured — on by default, persisted, gates separation without editing `.env`.
   Confirm word timing improves vs. before on a dense-mix song.
3. **Stem-aware tuning is already wired:** when alignment runs on the isolated
   stem, `refineTimelineWithAudio` lowers `minScore` (0.3→0.15) and relaxes the
   onset-snap gate/window; the raw-mix path keeps the conservative gates. No
   further change needed — it activates automatically when separation is used.

**Staged and dormant (ships now, inert until a model is set):** the toggle
(`app/index.html` `#vocal-isolation-row`, `app/app.js`) and stem tuning
(`app/align.js`). With no model, `separateAvailable()` is false → toggle hidden,
stem tuning never triggers, raw-mix alignment unchanged.

Tooling shipped for this: `scripts/separate-check.mjs`, `decodeWAV` in
`app/wav.js` (tested), `separateStatus()` in `electron/separate.cjs`,
`SEPARATE_*` in `.env.example`.

**Integration in this codebase**
- New IPC `separate-vocals` (preload `separateVocals`) mirroring `align-song`.
- `refineTimelineWithAudio`: once per file (separation is expensive; do NOT do it
  per batch), request the vocal stem, cache it, then feed the stem PCM into the
  existing per-line CTC path in place of the raw mix. Everything downstream is
  unchanged.
- Cache the separated stem per track (alongside the aligned-timeline cache) so
  replays skip it.
- Relax `MIN_WORD_SCORE` and widen onset-snap prominence on a stem (cleaner
  signal → higher-confidence emissions, trustworthy energy onsets).

**Effort / risk:** medium–high. Model download (cache like the align model in
`~/.cache/bar4bar-transformers`), CPU latency (~10–60 s for a 4-min song on CPU —
run in background with progress, allow disable), memory. Soft-fail to the raw-mix
path so nothing regresses when unavailable.

### 2. Stronger / multilingual acoustic model

`wav2vec2-base-960h` is small and **English-only** — non-English lyrics are
aligned via lossy romanization tokens today.

- **English, sharper:** `wav2vec2-large-960h-lv60` — drop-in via the existing
  `ALIGN_MODEL` env override; larger (~300 MB) and slower.
- **Multilingual:** Meta **MMS** (`facebook/mms-*`) CTC or a multilingual
  wav2vec2 — real fix for Hindi/Japanese/etc., but vocab/tokenizer differs from
  the hard-coded `WAV2VEC2_960H_VOCAB` in `electron/align.cjs`; needs a
  per-model vocab/label map (and possibly language adapters).
- **Phoneme CTC** (e.g. charsiu): finer sub-word timing, better for sung
  vowels/melisma, but needs G2P of the lyrics.

**Recommended:** expose as an opt-in "High accuracy" mode (bigger download,
slower) rather than the default, and generalize `align.cjs` to accept a
model-supplied vocab/blank/separator instead of the hard-coded 960h vocab.

## Sequencing

1. Vocal separation (biggest accuracy win, unlocks aggressive onset-snap).
2. Generalize `align.cjs` vocab handling → enables model swaps.
3. Opt-in large/multilingual model for non-English and max accuracy.
