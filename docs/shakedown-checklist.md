# smart_lyric — End-to-End Shakedown Checklist

Purpose: the code is heavily unit-tested but the **integration + hardware seams have never
been run for real**. This is a scripted pass to turn "untested" into a ranked defect list.
Run it in the Electron app (`npm start`), and for each item note: ✅ works / ⚠️ works-but-off
/ ❌ broken, plus anything from the DevTools console (View → Toggle Developer Tools).

Paste results back and we fix in the order reality reveals.

---

## 0. Offline checks (no app needed)

- [ ] **`npm test`** → expect `pass 240, fail 0`.
- [ ] **Separation ear-check.** Open `song.vocals.check.wav` (just generated, 1.3× realtime,
      stem rms 0.1182 vs mix 0.2515). Does it sound like **isolated vocals** with instruments
      largely gone? Rate: clean / muddy / artifacts / instruments bleed through.
      - Regenerate anytime: `node --env-file=.env scripts/separate-check.mjs song.wav out.wav`
- [x] **Alignment quality numbers.** Done 2026-07-27 across all 7 test songs.
      Separation raises the share of high-confidence words on **every** song
      (+1.3 to +24.5 pp) and clears Nirvana's 14% line-level fallback to 0%.
      Keep separation unconditional; no adaptive skip. Full table and the
      rejected-heuristic analysis in `docs/alignment-accuracy-roadmap.md`.
      - Re-run: `node --env-file=.env scripts/align-check.mjs your.wav your.lrc --both`
      - ⚠️ Scores are only meaningful with the **correct** lyrics for that audio.

---

## Run 1 — Local audio file (the cleanest path; separation is ON here)

1. [ ] Attach a local audio file + enter its song/artist. Lyrics load?
       - Which provider won? (word-level NetEase `yrc` / line-level LRCLIB / plain+estimated)
2. [ ] On Play, does the **"Aligning vocals… N/M"** progress appear, then a badge flip?
       - Console: any "Isolating the vocal…" status? Any model-load error toast?
3. [ ] **Sing a full verse against it.** Judge each, 1–5:
       - Cue-lead: do words light up slightly *before* you should sing them, or late?
       - Count-in (3-2-1 runway before a line after a gap): present? well-timed?
       - Syllable glow / wipe: helps or distracts?
       - Breath gaps between lines: natural or rushed?
       - Instrumental stretches: does the highlight correctly go quiet (♪ + "next line in Ns")
         or does it park on a word nobody's singing?
       - Confidence: any sections render whole-line instead of word-by-word? Did those actually
         feel less certain?
4. [ ] Drift chip (now-bar): what does it show for a clean local file? (expected: idle/hidden —
       local exact-clock has no live samples)

## Run 2 — Spotify (aligns continuously on the RAW mic mix)

1. [ ] Connect Spotify, play a track. Lyrics load + follow?
2. [ ] **Follow smoothness:** does the highlight sit steady, or drift ahead/behind and snap back?
       (This is the ease-clock; note direction + rough magnitude.)
3. [ ] Does mic capture engage? Console: capture device chosen? "Aligning to the vocal…"?
       Do words visibly **sharpen** a few seconds in, or stay on the syllable-spread guess?
4. [ ] Manual sync dial (`]` earlier / `[` later / `\` reset) — does nudging help?
5. [ ] Drift chip: does it ever show "in sync / late / early"?

## Run 3 — Vinyl (hardware seam — never run for real)

Pre-req: **`which fpcalc`** must print a path (Chromaprint). If missing:
`brew install chromaprint`. Report if it was missing.

1. [ ] Play a record **from the start**. Click "Listen to a record".
2. [ ] Does AcoustID **identify** it within ~5–10s? (title/artist correct?)
       - Console: any AcoustID / reference-fetch errors? (we added logging for these)
3. [ ] Lyrics load and the highlight **follows the record**? How far off is sync?
4. [ ] **Needle-drop test:** lift and drop the needle mid-record. Does it re-identify and
       jump the highlight to the right spot (fingerprint-offset), or only work from the start?
5. [ ] Continuous mic alignment: over 30s, does sync tighten or wander?

---

## What to send back
A short list like: `Run1.3 instrumental: ❌ parks on last word ~4s into solo` /
`Run2.2 follow: ⚠️ ~300ms behind, snaps every few sec` / `Run3.2 AcoustID: ✅ identified`.
That becomes the Phase 2 fix queue.
