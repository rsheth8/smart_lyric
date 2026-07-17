# Bar4Bar — Handoff

Last updated: 2026-07-16

Projector-ready lyric-follow / karaoke display. Clock-driven highlighting (display never reads audio directly). Multi-medium inputs, multi-format lyrics, Spotify follow, OBS/projector outputs.

---

## Current status

| Area | Status |
|------|--------|
| Display + LRC sync | Working |
| Word-level lyrics (NetEase `yrc` karaoke) | Working |
| Word-level lyrics (**Musixmatch `richsync`**) | Wired 2026-07-16; live fetch verified (Coldplay “Yellow”) |
| Syllable-weighted word interpolation (fallback) | Working |
| **Forced alignment** (CTC, wav2vec2) — audio-file path | Implemented 2026-07-16; core unit-tested. Live model run pending first-run download + real-audio check |
| Language aid — **T** cycles Off → Pronunciation → English | Working |
| No-lyrics fallback (plain → estimated scroll / reading mode — **P**) | Working (Genius needs token) |
| Manual search + live iTunes suggestions | Working |
| Chart recommendations (iTunes top songs) | Working |
| Local audio file + ID3/Vorbis tags | Working |
| Local lyrics import (.lrc / .srt / .ass) | Working |
| Vinyl mic → **ACRCloud** (ambient, Electron) | Wired 2026-07-16; needs ACRCloud keys + turntable test |
| Vinyl mic → AcoustID (Electron) | Deprecated for live: Chromaprint can't match a room mic (returns 0 results). Kept for audio-file identify. |
| Fingerprint mid-song offset + calibrateRate | Implemented |
| SongSession + providers + mediums | Refactored in |
| OBS overlay (`overlay.html` + BroadcastChannel) | Working |
| Electron projector window | Working |
| Spotify PKCE login (desktop = system browser + loopback) | Reworked 2026-07-16; verify after restart |
| Spotify app-initiated playback + follow-poll | Working |
| In-app transport (play/pause) | Working |
| Apple Music | Stubbed (needs developer token) |
| Vercel deploy | Live at https://smartlyric.vercel.app/ |

**Tests:** `npm test` → 110 passing.

> **Forced alignment implemented (CTC, 2026-07-16):** the last timing step —
> per-word timings from the *actual vocal*. Line start/end anchors (richsync/LRC)
> stay; only the within-line word spread is re-timed from the audio, so the
> highlight tracks the singer instead of a mechanical syllable sweep. Pieces:
> `lib/forced-align.mjs` (pure CTC trellis+backtrack, the torchaudio
> CTC-segmentation algorithm — fully unit-tested), `lib/align-text.mjs` (lyric →
> vocab token sequence, tested), `electron/align.cjs` (runs a wav2vec2 CTC model
> via `@huggingface/transformers`/onnxruntime-node → per-frame log-probs → align →
> per-word seconds), `align-song`/`align-available` IPC + `window.bar4bar.alignSong`,
> and `app/align.js` (decodes audio to 16 kHz mono via OfflineAudioContext, calls
> the bridge, patches `timeline.lines[].words[]` in place). Wired into the
> **audio-file** path in `app.js` `loadSong` → `refineAudioTiming()` (runs in the
> background after playback starts; a "Timing aligned to the vocal" toast when it
> lands). To keep wav2vec2's O(n²) attention bounded it aligns **per line window**
> (~2–5 s each), one small inference per line, not the whole song at once.
> **Desktop-only** (needs the Electron bridge + model); soft-fails everywhere else
> so line/syllable timing always remains. **First run downloads ~90 MB** acoustic
> model (`Xenova/wav2vec2-base-960h`, override via `ALIGN_MODEL`) to
> `~/.cache/bar4bar-transformers`. **Not yet verified end-to-end** — the HF model
> download was blocked (gateway 504) in the build sandbox; needs a real run on a
> normal network + a real song to confirm alignment quality. Model is
> **English/Latin** — for non-Latin lyrics, align the romanization (`line.roman`)
> upstream (follow-up). Vinyl line-in / Spotify-loopback need *streaming windowed*
> alignment (we only hold the last N seconds live) — documented follow-up below.

> **Spotify follow jitter fix — "randomly ahead/behind" (2026-07-16):** the real
> cause of unstable following was `StreamingClock.observe()` **hard-snapping on any
> poll >0.75s from its prediction**. Spotify's `/currently-playing` `progress_ms` is
> coarse (updates ~1/s, trails real output by a device buffer) and arrives over
> variable latency, so ordinary staleness routinely crossed 0.75s and snapped the
> highlight — in both directions, every few seconds. Fix: since digital playback
> runs at exactly rate 1.0 and never drifts, the free-running clock is already
> accurate between polls, so polls should only make *invisible* corrections. New
> three-band `observe()`: **deadband 0.15s** (hold — ignore sub-perceptible poll
> noise instead of chasing it), **ease 0.2 up to jumpThreshold** (gentle drift-track),
> **snap only beyond 1.5s** (genuine seek/track jump). Known discontinuities still
> use `set()` (unchanged). Simulated over 40s of realistic noisy polls: visible
> jumps **6 → 0**, RMS deviation 0.33s → 0.19s, max 0.98s → 0.36s. 136 tests
> (added deadband/no-false-snap/genuine-seek cases). The manual sync dial (`]` `[`
> `\`) still stacks on top for any residual device-latency offset.

> **10-foot "couch" UI + cinematic pass (2026-07-16):** the setup menu is now a
> TV-style experience aimed at projector/Apple TV viewing (today via AirPlay/HDMI
> from the Mac; a native tvOS app is a documented future project, below).
> *Navigation:* new `app/tv-nav.js` — tvOS-style geometric D-pad focus movement
> (`pickNext` is pure + unit-tested; 133 tests total). Arrows move focus across
> search → sync tiles → shelves, Enter activates, **Escape backs out of the lyric
> view** (remote Menu), any key wakes the auto-hiding now-bar. Inputs keep their
> caret/suggestion keys (nav is gated by `isActive` in app.js).
> *Layout:* Recommended / From Spotify are horizontal **poster-card shelves**
> (scroll-snap, hidden scrollbars) instead of dense grids; panel widened to
> `min(1020px, 94vw)` and all setup-screen type scales with `clamp(…vw…)` so a
> projector at couch distance reads like a laptop up close. tvOS-style focus ring
> (bright ring + halo + lift) on all setup controls.
> *Cinematic motion:* lyric depth-of-field (active line crisp/full-size, others
> blurred `1.6–2.2px`, scaled `.965`, `text-wrap: balance`), setup↔playing scene
> push (menu drifts to `scale(1.02)` as lyrics fade in from `.985`), panel
> entrance rise, now-bar slide-in. Neutral cinematic palette kept (user's call).
> All new motion honors `prefers-reduced-motion`. Fixed: the timing badge
> ("Line sync · …") used to persist on the setup screen — now hidden outside
> playing mode. NOTE: overlay.html shares styles.css, so the projector/OBS
> surface inherits the same DOF treatment (intended).
>
> **tvOS migration path (future):** the UI is now structured for it — focus-driven
> navigation (tv-nav mirrors the tvOS focus engine), shelf/card layout, Escape=Menu.
> A native app would be a Swift/tvOS shell around the same provider/clock/display
> model; the web renderer can't run on tvOS (no browser/webview app path), so the
> realistic route is SwiftUI + the same LRCLIB/NetEase/Musixmatch fetchers (they're
> plain HTTPS) with lyrics rendering ported. Until then: AirPlay/HDMI the Mac app.

> **Duration-aware lyric matching (2026-07-16):** the single biggest match-accuracy
> lever. Every medium supplies a target track **duration** (Spotify `duration_ms`,
> iTunes `trackTimeMillis`, decoded audio length, ACRCloud) — the strongest signal
> for telling the *right recording* from a same-titled cover / live take / remix /
> wrong song. It reached `fetchLyrics` but was dropped before matching. Now threaded
> everywhere: new pure `app/providers/lyrics/match.js` (`durationScore`,
> `durationMismatch`, `candidateScore`, `preferResult` — unit-tested). LRCLIB
> `pickBestMatch` ranks by title *and* length (breaks the album-vs-live tie); NetEase
> `searchSongId` folds `song.duration` (ms) into scoring, pool widened 5→10, returns
> `meta.duration`; `duration` param plumbed through `/api/lyrics` (server.mjs +
> Vercel `api/lyrics.js`) and the Electron bridge. Crucially, `fetchLyrics` no longer
> preferred word-level *unconditionally*: `preferResult` keeps the word-level-first
> preference order but **skips any candidate whose length grossly mismatches
> (≥22s)** the target, so a wrong-take yrc/richsync hit yields to a correct
> line-level LRCLIB match — falling back to raw order only if all mismatch or no
> duration is known (old behavior preserved). Live-verified: LRCLIB pick flips to the
> length-matching take (277s vs 299s "Passionfruit"); NetEase returns `meta.duration`.
> 127 tests (was 111).

> **Musixmatch richsync wired end-to-end (2026-07-16):** the parser
> (`app/providers/formats/richsync.js`), client provider
> (`app/providers/lyrics/musixmatch.js`), and server fetcher (`lib/musixmatch.mjs`)
> existed but nothing connected them. Now wired: `/api/richsync` route in
> `server.mjs` + `api/richsync.js` (Vercel, added to `vercel.json`) + `richsync`
> IPC in `electron/main.cjs` and `window.bar4bar.richsync` in `preload.cjs`.
> `fetchLyrics` (`providers/lyrics/index.js`) now runs NetEase, **Musixmatch**, and
> LRCLIB in parallel and prefers **word-level** timing: NetEase `yrc` → Musixmatch
> `richsync` → NetEase line+roman → LRCLIB line → plain. Works in Spotify mode (no
> audio needed) — the big word-by-word coverage win for Punjabi/Bollywood/Western.
> No API key: it uses the reverse-engineered `apic-desktop` token endpoint (ToS
> gray area, like the Genius scrape). **Caveat:** that token endpoint captcha-blocks
> datacenter IPs — verified working from a residential IP, returns `null` under
> rate-limit and the chain falls back cleanly. Most reliable from the Electron main
> process (residential IP + in-memory token cache); on Vercel it often falls back to
> LRCLIB. Also fixed a pre-existing gap: `api/genius.js` was never routed in
> `vercel.json` (plain-lyrics fallback was dead on prod) — now routed too.

> **Vinyl pause-on-silence + input picker (2026-07-16):** live listen now watches
> the mic RMS (`Mic.level`) in the RAF meter loop and pauses `vinylClock` after
> ~1.5s of silence (`LISTEN_SILENCE_HOLD_MS`) instead of letting the predictive
> clock scroll on for ~20s (4 missed 5s polls). Resumes on the next fingerprint
> match, or immediately (`PredictiveClock.resume()`) if audio returns on the same
> locked track. UI shows "Paused — waiting for the music…" and the play button
> reads Paused. Added an input-device `<select>` in the listen panel
> (`#listen-input`) → `Mic({ deviceId })`, so you can pick a clean line-in/USB
> source. **Best signal for the Sony PS-LX310BT: its USB Type-B port** (clean
> post-phono-preamp digital, shows up as a Mac audio input). Its Bluetooth is
> transmit-only to speakers/headphones — it *cannot* pair to a computer, and
> macOS can't be a BT audio sink anyway.

> **Electron main is now CommonJS (2026-07-16):** `electron/main.js` → renamed
> `electron/main.cjs` (`package.json` `main` updated). Electron 31 + Node 20's ESM
> loader crashes preparsing the built-in `electron` module's exports when the main
> entry is ESM. CJS main is the supported path; the two ESM lyric helpers
> (`lib/netease.mjs`, `lib/genius.mjs`) are loaded via dynamic `import()`.
> GOTCHA that wasted debugging time: if `ELECTRON_RUN_AS_NODE=1` is set in your
> shell, `electron .` runs as plain Node (require('electron') → binary path, `app`
> undefined; ESM import also crashes). `unset ELECTRON_RUN_AS_NODE` before `npm start`.

> **Live vinyl recognition → ACRCloud (2026-07-16):** the mic → AcoustID path
> was validated and *fails* for live capture — Chromaprint only matches
> near-identical digital audio, so a mic pointed at a turntable returns
> `0 result(s)` every poll (confirmed in `[vinyl]` terminal logs; AcoustID DB is
> ~21.5M recordings, so it's the method, not coverage). Replaced with **ACRCloud**
> (landmark fingerprinting built for ambient/over-the-air capture). New
> `electron/acrcloud.cjs` (`identifyAcr`, HMAC-SHA1 signed Identify API call) +
> `identify-ambient` IPC + `window.bar4bar.identifyAmbient`. `loadEnvConfig()`
> exposes `acrCloud` (true when keys present); `app.js` reads it and passes
> `useAmbient` so the vinyl medium calls ACRCloud when configured, else AcoustID.
> ACRCloud returns `play_offset_ms` → used as the clock position (mid-song needle
> drops). **Needs keys:** `ACRCLOUD_HOST` / `ACRCLOUD_ACCESS_KEY` /
> `ACRCLOUD_ACCESS_SECRET` from https://console.acrcloud.com/ (free "Audio & Video
> Recognition" project). Also added a live mic-level meter + per-poll status in
> the listen panel (`#listen-panel`) so "is it hearing / matching?" is visible.
> Full Electron restart (Cmd+Q) needed — main-process change.

> **No-lyrics fallback (2026-07-16):** when no *synced* source has the song, the
> chain now falls back to plain (untimed) text: LRCLIB `plainLyrics` (was
> discarded) → lyrics.ovh (both client-side, CORS-ok) → Genius (server-side:
> needs `GENIUS_ACCESS_TOKEN`, scrapes the page — ToS caveat, skipped without a
> token). Plain text is shown with **estimated timing** (lines spread across the
> duration, line-level highlight only, "Estimated timing" badge) so it still
> auto-follows; press **P** for a static plain reading-mode scroll. New:
> `app/providers/lyrics/plain.js`, `app/providers/formats/estimate.js`,
> `lib/genius.mjs`, `api/genius.js`, `/api/genius` route + `genius-lyrics` IPC
> (`window.bar4bar.geniusLyrics`). Restart the dev server for the `/api/genius`
> route; Genius also needs the token in `.env`.

> **Language aid — pronunciation + English (2026-07-16):** **T** cycles Off →
> Pronunciation → English (skips modes that don't apply). Both fill on demand via
> the free Google endpoint (`app/providers/translate.js`, client-side, CORS `*`):
> `translateLines` (dt=t) → English meaning on `line.english`; `romanizeLines`
> (dt=rm) → Latin-letter pronunciation on `line.roman` for **any** non-Latin
> script — **Hindi/Devanagari, Arabic, Cyrillic, Thai**, plus CJK/Hangul. NetEase
> `romalrc` (fetched via `rv:0` → `rlrc`) still pre-fills `line.roman` for JP/KO/ZH.
> `needsRomanization()` gates whether Pronunciation is offered. Display renders a
> `.line-sub` row toggled by `#lyrics.show-sub` (`display.setAidMode`/`cycleAid`).
> NOTE: NetEase `tlyric` is Chinese so it's NOT used. Many Bollywood songs arrive
> already-romanized (Latin) from LRCLIB → no aid needed; Devanagari ones get
> Google romanization. Restart `npm run dev` for the `lib/netease.mjs` `rv` change.

> **Spotify smooth-sync (2026-07-16):** `StreamingClock` now owns a free-running
> anchor and *eases* toward each follow-poll (`observe()`), snapping only on
> discontinuities (track change / seek / resume / >0.75s gap). Previously every
> 1.5s poll hard-reset the anchor → up-to-twice-a-second jitter. This is the fix
> for "lyrics slightly ahead/behind." Digital rate is fixed at 1.0; `lead`
> (0.2s) compensates device output buffer; the manual sync dial stacks on top.
> MusicKit/exact SDKs pass `getPosition` to bypass the ease model.

> **Rebrand (2026-07-16):** the project is now **Bar4Bar** (package `bar4bar`). The
> Electron preload bridge is `window.bar4bar` (was `window.smartLyric`) — any new
> renderer code must use `window.bar4bar`. Vercel alias/URL is unchanged.

---

## How to run

```sh
npm install
cp .env.example .env   # fill keys
npm run dev            # http://localhost:4321  (or http://127.0.0.1:4321)
npm start              # Electron desktop (vinyl + projector + Spotify popup)
npm test
```

### Env vars

| Variable | Needed for |
|----------|------------|
| `ACRCLOUD_HOST` / `ACRCLOUD_ACCESS_KEY` / `ACRCLOUD_ACCESS_SECRET` | **Live vinyl/mic auto-detect** (ambient recognition) |
| `ACOUSTID_API_KEY` | Audio-file identify only (not live mic) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify |
| `SPOTIFY_REDIRECT_URI` | **Web build only** — must match Dashboard + Vercel (e.g. `https://smartlyric.vercel.app/`). Desktop ignores this and uses the loopback URI below. |
| `APPLE_MUSIC_DEVELOPER_TOKEN` | Apple Music (optional) |

**Spotify Dashboard → Redirect URIs must list ALL three:**
- `https://smartlyric.vercel.app/` — production web
- `http://127.0.0.1:4321/` — local web dev (`npm run dev`)
- `http://127.0.0.1:18923/callback/` — desktop app (`npm start`), trailing slash required

Vinyl also needs: `brew install chromaprint` (`fpcalc` on PATH).

**Keys:** ↑↓←→ = navigate (setup) · Enter = select · Esc = back to menu · F = fullscreen · Space = play/pause · T = language aid (pronunciation/English) · P = plain reading mode · `]` `[` `\` = sync nudge

---

## Architecture (keep this split)

```
Identity (what song?)  →  Lyrics providers (LRCLIB / local file)
                       →  Format parsers → Timeline
Position (where?)      →  Clock (Media / Predictive / Streaming / Passive)
Render                 →  Display (RAF loop: clock.now() → highlight)
```

### Key paths

```
app/
  app.js                 UI wiring + busy overlay + Spotify connect + transport + resetSongState()
  session.js             SongSession orchestrator
  clock.js               MediaClock · PredictiveClock · StreamingClock · PassiveClock
  display.js             Keyword: do not put medium logic here
  recommendations.js     iTunes charts + search suggestions + Spotify recent API
  providers/lyrics/      local → (NetEase yrc ∥ Musixmatch richsync ∥ LRCLIB) — see "Lyrics fetch"
  providers/formats/     LRC · SRT · ASS · YRC · richsync (word-level) → timeline
  mediums/               manual · audioFile · vinyl · spotify · appleMusic
  streaming/             PKCE auth, Spotify play + follow-polling, Apple Music stub
  sync-bridge.js         BroadcastChannel for overlay
  overlay.html / .js     OBS / projector lyric surface
electron/
  main.cjs               Window + projector + Spotify loopback OAuth server (127.0.0.1:18923). CJS on purpose (see note).
  acrcloud.cjs           ACRCloud ambient recognition (live vinyl/mic) — HMAC-signed Identify API
  fingerprint.cjs        fpcalc + AcoustID + offset alignment
  align.cjs              Forced alignment: wav2vec2 CTC (Transformers.js) → per-word vocal timing
app/
  align.js               Renderer: decode audio → 16 kHz mono, call align bridge, patch timeline
lib/
  netease.mjs            NetEase yrc/lrc/roman fetch (ESM, used by dev server + Electron)
  musixmatch.mjs         Musixmatch richsync fetch (reverse-engineered token endpoint)
  genius.mjs             Genius plain-lyrics scrape (needs GENIUS_ACCESS_TOKEN)
  forced-align.mjs       Pure CTC trellis+backtrack alignment (unit-tested, no deps)
  align-text.mjs         Pure lyric-text → CTC vocab token sequence (unit-tested)
  preload.cjs            window.bar4bar bridge (identify, spotifyLogin, wordLyrics, projector…)
api/
  config.js              Vercel /config.js → injects public env (client id, redirect)
```

---

## Mediums & formats

**Inputs:** manual search · audio file · lyrics file · vinyl (Electron) · Spotify · Apple Music (token)

**Lyrics fetch (`providers/lyrics/index.js`):** local file first (if attached) → then
**NetEase, Musixmatch, and LRCLIB run in parallel** (no longer a serial chain).
Prefer **word-level** timing (it visibly tracks the singer): NetEase `yrc` →
Musixmatch `richsync` → NetEase line+roman → LRCLIB line-level → plain fallback.
Racing them stops a slow provider from blocking lyrics for 8s+ while Spotify is
already playing. NetEase bridge/proxy call has a 9s timeout; richsync 10–12s.
Query titles/artists are normalized via `cleanTrackTitle()` (strips
`(Remastered)`/`(feat. …)`/`- Live` noise) and `primaryArtist()` (first credited
artist only) before hitting either provider.

**Formats:** LRC (line + word), SRT, ASS (`\k` karaoke), YRC (NetEase word-level)

**Outputs:** main window · `overlay.html` (OBS Browser Source) · Electron second/projector window

---

## Spotify — known gotchas (important)

1. **Desktop auth now uses the SYSTEM browser + a loopback HTTP server**
   (`electron/main.js`, OAuth for Native Apps / RFC 8252). Old embedded popup
   `BrowserWindow` is gone — Spotify blocks OAuth inside embedded webviews with
   endless "are you human" challenges. Flow: main process starts an `http` server
   on `127.0.0.1:18923`, `shell.openExternal(authUrl)` opens the real browser,
   the redirect to `http://127.0.0.1:18923/callback/` lands on that server, code
   is exchanged, tab shows a "Connected" page and auto-closes, main window refocuses.
   - Redirect URI `http://127.0.0.1:18923/callback/` **must** be in the Dashboard
     (trailing slash matters). 5-min timeout; `EADDRINUSE` = a stale login attempt.
2. **Spotify rejects `localhost`.** Web build uses `https://smartlyric.vercel.app/`
   (prod) or `http://127.0.0.1:4321/` (local dev). Web still uses `SPOTIFY_REDIRECT_URI`.
3. **App-initiated playback:** picking a song calls `playSpotifyTrack()` to start it
   on the user's active Spotify device. Track match is scored (name/artist overlap,
   penalize live/karaoke/cover) in `streaming/spotify.js`. Lyrics + playback are
   fired **in parallel** so lyrics don't wait behind the play call.
4. Follow mode **polls** `/me/player/currently-playing` (~1.5s) — works for
   phone/desktop Spotify, not only the Web Playback SDK device.
5. **Connect stays on the setup screen** (no jump to an empty "Following…" view).
   The follow-poll runs in the background; the first detected track flips to the
   playing view. When already connected, follow runs with no modal so the user can
   still search/pick a song. The "From Spotify" panel is hidden when it has no cards.
6. **`resetSongState()`** is called on Change / vinyl / streaming-connect so a
   previously attached audio/lyrics file doesn't leak into the next song's lyrics.
7. Clicking Connect shows a **busy overlay** (`#busy`). If nothing visible, check
   `#setup-status` error text.
8. After Electron code changes: **Cmd+Q** fully quit, then `npm start` again (not just reload).

### Vercel

- Project: `rsheth8s-projects/smart_lyric`
- Alias: https://smartlyric.vercel.app/
- Env on Vercel: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
- `vercel.json`: static `app/**` + `api/config.js`; `/config.js` → API
- Redeploy: `vercel --prod --yes`
- `.vercelignore` excludes `electron/` so Vercel doesn’t treat Electron as the serverless entrypoint

---

## UX surface (setup)

- Wider search panel with live suggestions
- Sync tiles: Spotify · Vinyl · Audio file · Lyrics file
- Recommended (iTunes charts)
- From Spotify (recently played / now playing) when connected — hidden when empty
- Busy overlay during Spotify connect
- In-app transport controls (play/pause) on the playing screen

---

## Open / next work

- [ ] Real-world vinyl testing (needle drop mid-track, drift)
- [ ] Confirm Spotify end-to-end on Electron (new loopback auth) + Vercel after rebrand
- [ ] Add `http://127.0.0.1:18923/callback/` to the Spotify Dashboard if not already there
- [ ] Apple Music MusicKit developer token flow end-to-end
- [ ] Low-confidence / no-lyrics recovery UX
- [x] System audio / line-in (reuse vinyl path) — input-device picker + pause-on-silence
- [x] **Forced alignment** (CTC) — audio-file path implemented (see note above).
- [ ] Forced alignment: **verify end-to-end** on a real machine (first-run model
      download + a real song); tune `MIN_WORD_SCORE` / `WINDOW_PAD_SEC` if needed.
- [ ] Forced alignment: **non-Latin lyrics** — feed the romanization to the aligner
      (English/Latin acoustic model can't tokenize Devanagari/Gurmukhi directly).
- [ ] Forced alignment: **vinyl line-in / Spotify loopback** — streaming windowed
      alignment (align the last few seconds as audio arrives, not the whole song).
- [ ] Consider a quantized dtype (`{ dtype: 'q8' }`) for faster CPU inference.
- [ ] Optional: transfer playback to Web Playback SDK device for louder control apps

---

## Forced alignment — design notes (implemented; see status note above)

Goal: per-word timings computed from the **actual vocal**, so highlighting follows
the singer's phrasing / held notes / pauses instead of the syllable estimate.
**Status:** the CTC route (option 1 below) is built for the audio-file path.

Hard constraint = audio availability:
- **Audio file / vinyl line-in (USB-B):** clean audio in hand → alignment works well.
- **Vinyl mic:** works, degraded by room noise.
- **Spotify:** DRM, no raw stream → only possible by capturing speaker/loopback output.

So the line-in path (already built) + forced alignment are the natural pair; the
clean USB-B signal from the Sony PS-LX310BT is ideal input.

Two implementation routes:
1. **CTC forced alignment (gold standard).** Feed the audio + known lyric text to a
   phoneme/char CTC model (WhisperX, or `torchaudio`/`ctc-segmentation`, or an ONNX
   wav2vec2) → true word boundaries. Heavy: a Python sidecar or onnxruntime model
   bundled in Electron, CPU-intensive, a few seconds of processing per song. Best
   quality. Suggested shape: `electron/align.cjs` spawns the aligner, renderer sends
   the captured/decoded PCM + the timeline's word list, gets back `[{i, start, end}]`
   and patches `timeline.lines[].words[]`. Keep it behind the same provider/medium
   split — display stays clock-agnostic.
2. **Lightweight vocal-energy nudge (no model).** Run the already-fetched word
   estimate, then snap word onsets to local energy/onset peaks in the line's audio
   window. Zero new deps, ships fast, ~70% of the benefit for clearly-enunciated
   audio; not true phoneme alignment.

Integration point exists: timelines are `{ lines:[{start,end,words:[{text,start,end}]}] }`
— an aligner just rewrites word start/end in place, so nothing downstream changes.

## Don’t break these

- Display stays clock-agnostic (`now()` / `isPlaying()` only)
- Timeline shape: `{ lines: [{ start, end, words: [{ text, start, end }] }], duration }`
- Prefer provider/medium plugs over new hardcoded paths in `app.js`
- Never commit `.env` (secrets). Client ID is public in `/config.js` by design.

---

## Quick verify checklist

```sh
npm test
npm run dev          # search + recommendations + load lyrics
# Electron:
npm start            # Connect Spotify → overlay → play track → lyrics follow
# OBS:
# Browser Source → http://localhost:4321/overlay.html (transparent)
```
