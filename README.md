# smart_lyric

A projector-ready, auto-detecting lyric-follow / karaoke display. Point a mic at
your record player (or pick a song manually); the app fetches time-synced lyrics
and follows along bar-for-bar with a cinematic, word-by-word highlight.

## Status

- **Milestone 1 — display + sync engine — ✅ working.** Fetches synced lyrics from
  LRCLIB, parses them (with word-timing interpolation), colors the ambient
  background from the album art, and drives a cinematic word-by-word highlight off
  a swappable clock.
- **Milestone 2 — vinyl auto-detect — next.** Wire the Step 0 fingerprint spike
  (`identify.py`) into a `PredictiveClock` so the mic identifies the song + position
  and the display locks on, drift-corrected.

## Run it

```sh
npm run dev      # → http://localhost:4321  (zero-dependency dev server)
npm test         # unit tests (node:test)
npm start        # desktop app (needs: npm install, to fetch Electron)
```

For auto-detect, put your AcoustID **application** API key in `.env`
(`cp .env.example .env`, then paste the key). Get one at
https://acoustid.org/new-application — the app loads `.env` automatically.

In the app: type an artist + song → **Load lyrics** → **Play** to preview the
scroll, or **Open audio file…** to attach a track for exact playback sync.
**F** = fullscreen (the projector view). **Space** = play/pause.

## Architecture

The display never reads audio directly — it asks a `clock` "what second are we on?"
each frame. Swapping the clock is what lets the same screen follow app playback OR
external vinyl.

```
app/
  index.html · styles.css   cinematic screen (dark, full-bleed)
  lrc.js       LRC parser + word-timing interpolation
  clock.js     MediaClock (exact) · PredictiveClock (drift-corrected, for vinyl)
  display.js   render + centering + highlight engine
  lyrics.js    LRCLIB synced-lyrics provider
  art.js       iTunes artwork lookup + palette extraction
  app.js       wiring + load UI
electron/       desktop wrapper (main.js, preload.cjs)
server.mjs      dev server
test/           unit tests: lrc, clock, art, display
```

## Step 0 fingerprint spike (recognition proof)

`identify.py` records ~12s from the mic, fingerprints it with Chromaprint, and
queries AcoustID — the yes/no test for "can we ID vinyl through a mic?"

```sh
export ACOUSTID_API_KEY=your_key_here   # free: https://acoustid.org/new-application
./.venv/bin/python identify.py
```
