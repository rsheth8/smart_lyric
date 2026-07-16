# Bar4Bar — Handoff

Last updated: 2026-07-16

Projector-ready lyric-follow / karaoke display. Clock-driven highlighting (display never reads audio directly). Multi-medium inputs, multi-format lyrics, Spotify follow, OBS/projector outputs.

---

## Current status

| Area | Status |
|------|--------|
| Display + LRC sync | Working |
| Manual search + live iTunes suggestions | Working |
| Chart recommendations (iTunes top songs) | Working |
| Local audio file + ID3/Vorbis tags | Working |
| Local lyrics import (.lrc / .srt / .ass) | Working |
| Vinyl mic → AcoustID (Electron) | Wired; needs real turntable validation |
| Fingerprint mid-song offset + calibrateRate | Implemented |
| SongSession + providers + mediums | Refactored in |
| OBS overlay (`overlay.html` + BroadcastChannel) | Working |
| Electron projector window | Working |
| Spotify PKCE + follow currently-playing | Fixed recently; verify after restart |
| Apple Music | Stubbed (needs developer token) |
| Vercel deploy | Live at https://smartlyric.vercel.app/ |

**Tests:** `npm test` → 62 passing.

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
| `ACOUSTID_API_KEY` | Vinyl auto-detect |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify |
| `SPOTIFY_REDIRECT_URI` | Must match Spotify Dashboard + Vercel (e.g. `https://smartlyric.vercel.app/`) |
| `APPLE_MUSIC_DEVELOPER_TOKEN` | Apple Music (optional) |

Vinyl also needs: `brew install chromaprint` (`fpcalc` on PATH).

**Keys:** F = fullscreen · Space = play/pause

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
  app.js                 UI wiring + busy overlay + Spotify connect
  session.js             SongSession orchestrator
  clock.js               MediaClock · PredictiveClock · StreamingClock · PassiveClock
  display.js             Keyword: do not put medium logic here
  recommendations.js     iTunes charts + search suggestions + Spotify recent API
  providers/lyrics/      local → LRCLIB chain
  providers/formats/     LRC · SRT · ASS → timeline
  mediums/               manual · audioFile · vinyl · spotify · appleMusic
  streaming/             PKCE auth, Spotify follow-polling, Apple Music stub
  sync-bridge.js         BroadcastChannel for overlay
  overlay.html / .js     OBS / projector lyric surface
electron/
  main.js                Window + projector + Spotify auth popup (sync intercept)
  fingerprint.cjs        fpcalc + AcoustID + offset alignment
  preload.cjs            bar4bar bridge (identify, spotifyLogin, projector…)
api/
  config.js              Vercel /config.js → injects public env (client id, redirect)
```

---

## Mediums & formats

**Inputs:** manual search · audio file · lyrics file · vinyl (Electron) · Spotify · Apple Music (token)

**Lyrics sources:** local file first (if attached) → LRCLIB  
**Formats:** LRC (line + word), SRT, ASS (`\k` karaoke)

**Outputs:** main window · `overlay.html` (OBS Browser Source) · Electron second/projector window

---

## Spotify — known gotchas (important)

1. **Spotify rejects `localhost` redirect URIs.** Use:
   - Production: `https://smartlyric.vercel.app/` (trailing slash)
   - Local browser: `http://127.0.0.1:4321/` (prefer 127.0.0.1, not localhost)
2. Dashboard Redirect URI must **exactly** match `SPOTIFY_REDIRECT_URI` (local `.env` + Vercel env).
3. Electron auth uses a **popup** (`spotify-login` IPC). `preventDefault` on redirect **must be synchronous** — async `.then(preventDefault)` was a bug that made Connect Spotify appear dead (fixed 2026-07-15).
4. Follow mode **polls** `/me/player/currently-playing` (~1.5s) — works for phone/desktop Spotify, not only the Web Playback SDK device.
5. Clicking Connect shows a **busy overlay** (`#busy`). If nothing visible, check `#setup-status` error text.
6. After Electron code changes: **Cmd+Q** fully quit, then `npm start` again (not just reload).

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
- From Spotify (recently played / now playing) when connected
- Busy overlay during Spotify connect

---

## Open / next work

- [ ] Real-world vinyl testing (needle drop mid-track, drift)
- [ ] Confirm Spotify end-to-end on Electron + Vercel after latest fix
- [ ] Apple Music MusicKit developer token flow end-to-end
- [ ] Low-confidence / no-lyrics recovery UX
- [ ] System audio / line-in (reuse vinyl path)
- [ ] Optional: transfer playback to Web Playback SDK device for louder control apps

---

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
