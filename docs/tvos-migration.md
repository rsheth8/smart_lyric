# Bar4Bar for Apple TV (tvOS)

Native SwiftUI app that reuses Bar4Bar’s **clock → timeline → karaoke display** model.
Electron cannot run on tvOS; this target is the real Apple TV product.

## Layout

```
tvos/
  Bar4BarCore/     Swift package — clocks, formats, match, display math, lyrics client
  Bar4BarTV/       SwiftUI tvOS app — MusicKit + hub + karaoke
  project.yml      XcodeGen spec → generates Bar4BarTV.xcodeproj
```

## Prerequisites

1. Apple Developer Program membership
2. App ID with **MusicKit** capability (`com.apple.developer.music-kit` in entitlements)
3. Xcode 15+ / tvOS 17+ SDK
4. [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
5. Optional: Vercel deploy of this repo for NetEase yrc / Musixmatch richsync (`LYRICS_API_BASE`)

## Generate & run

```sh
cd tvos
xcodegen generate
open Bar4BarTV.xcodeproj
```

Select an **Apple TV** simulator or device, set your Development Team, then Run.

**Required once on this Mac:** install the **tvOS** platform / simulator runtime from Xcode → Settings → Platforms (or Components). Without it, `actool` fails with `No available simulator runtimes for platform appletvsimulator` even for device SDK builds.

Set build setting / Info `LYRICS_API_BASE` (via [`tvos/Bar4BarTV/Config/Debug.xcconfig`](../tvos/Bar4BarTV/Config/Debug.xcconfig)) to your Vercel origin (e.g. `https://your-app.vercel.app`) for word-level NetEase/Musixmatch via the existing proxies. Leave blank to use **LRCLIB only** (no secrets in the IPA).

CLI typecheck (no simulator runtime needed for Swift; asset catalog still needs the platform):

```sh
cd tvos
xcodegen generate
xcodebuild -project Bar4BarTV.xcodeproj -target Bar4BarCore -sdk appletvos \
  -configuration Debug CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build
```

## Core package tests

```sh
cd tvos/Bar4BarCore
swift test
```

(`Package.swift` remains for macOS unit tests of the pure ports; the Xcode app links the same sources as a tvOS framework target.)

## Demo mode

MusicKit does not run in the tvOS simulator — `MusicAuthorization` and
`ApplicationMusicPlayer` both need a real device with a subscription. Without a
second path the karaoke screen is unreachable, so the app ships a bundled demo:

- `Bar4BarTV/Demo/DemoSong.swift` — a 52 s timeline whose lyrics are **original
  text written for this app**. Never bundle real song lyrics: it is a copyright
  problem and an App Store review problem. Each line targets a display feature
  (held note, duet `agent`, fast line, two instrumental gaps).
- `Bar4BarCore/DemoClock.swift` — pausable / seekable / looping `SyncClock`, so
  the demo drives the *real* display path rather than a mock of it.
- Entry points: the hub's **See it in action** card and Settings ▸ Demo.

### Driving it from a script

The simulator gives no way to press the Siri Remote, so the demo can be started
— and parked on an exact frame — through the environment. Nothing is compiled
in; with no variables set, `DemoLaunch.autoStart` is false.

```sh
SIMCTL_CHILD_BAR4BAR_AUTODEMO=1 \
SIMCTL_CHILD_BAR4BAR_DEMO_SEEK=23.5 \
SIMCTL_CHILD_BAR4BAR_DEMO_PAUSED=1 \
xcrun simctl launch <UDID> com.bar4bar.tv
```

Frames worth capturing: `0.15` count-in runway · `3.0` word wipe mid-line ·
`10.5` instrumental ♪ · `23.5` the 5.2 s held note · `29.4` duet staging ·
`32.9` fast line · `50.5` outro.

### Reaching the other screens

Search and Settings sit behind a button press no script can make, so they were
the two screens that went unlooked-at the longest. `BAR4BAR_ROUTE` pushes one
directly; `BAR4BAR_FAKE_RESULTS` drives the browse surfaces, which otherwise
cannot render at all in the simulator because MusicKit will not run there.

| Variable | Values |
|---|---|
| `BAR4BAR_ROUTE` | `search` · `settings` · `karaoke` |
| `BAR4BAR_FAKE_RESULTS` | `results` · `empty` · `loading` · `error` |

```sh
SIMCTL_CHILD_BAR4BAR_ROUTE=search \
SIMCTL_CHILD_BAR4BAR_FAKE_RESULTS=results \
xcrun simctl launch <UDID> com.bar4bar.tv
```

The placeholder rows are unplayable by construction — they are never added to
`MusicPlayerService.catalog`, so selecting one takes the "no longer available"
path rather than pretending to start playback.

## Product cut line

| On Apple TV (v1) | Stays on Mac Electron |
|------------------|------------------------|
| Apple Music (MusicKit) playback + playhead | Vinyl / mic / AcoustID / ACRCloud |
| Catalog lyrics (LRCLIB + optional proxy) | Forced align, vocal separation, Whisper |
| Word wipe karaoke, sync nudge, singer lead | Local audio file sync |
| Hub shelves + search + remote focus | Spotify follow-poll / OBS projector |

## Phases checklist

- [x] Phase 0 — Scaffold (`Bar4BarCore` + XcodeGen app + MusicKit entitlement + brand assets)
- [x] Phase 1 — MusicKit playback + playhead → cue time
- [x] Phase 2 — Lyric pipeline (LRC / yrc / richsync / TTML subset + match + cache)
- [x] Phase 3 — Hub + karaoke wipe UI + sync nudge + empty/error states
- [x] Phase 3.5 — **Dark Luxury design pass + demo mode.** tvOS 26.5 simulator
      runtime installed, app builds and runs. `Theme/Theme.swift` replaces the
      stale pre-Dark-Luxury navy background with the real token set; the word
      wipe is a genuine gradient mask (it previously computed `wipeProgress` and
      threw it away, `let lit = wipe > 0.02`); DOF ladder, count-in, instrumental
      ♪, art-adaptive accent (`Core/ColorMath.swift`, hue-only OKLCh rebuild),
      duet staging, auto-hiding chrome. Core tests 10 → 36.
- [x] Phase 3.6 — **UX audit.** Every screen and state screenshotted, and the
      dead ends found by doing it closed. Settings was still a stock `Form`
      (system grey-blue plate, explanatory paragraphs rendered as pressable
      rows) and is now a two-column token-built page. Search gained real
      loading / empty / no-match / error states and a grid. `SongItem` replaces
      `MusicKit.Song` in the view layer. Core tests 36 → 39.
- [ ] Phase 4 — Device build on real Apple TV (only way to verify MusicKit);
      TestFlight; App Store screenshots; ToS review for lyric proxies

### Fixed in the audit

| Symptom | Cause |
|---|---|
| Settings ▸ Play the demo did nothing | the root's auto-push deliberately skips demo tracks, and Settings never pushed for itself |
| Picking a search result landed you on the hub | the auto-push guard needs a loaded timeline, which never exists that early |
| Stopping the demo left its lyrics scrolling | lyrics reload on `nowPlaying` becoming non-nil, so clearing the track alone left the timeline in place |
| Karaoke empty state was a dead end | one grey sentence, no action, under transport chrome for a track that did not exist |
| Nothing focused on the karaoke empty state | the backdrop stops being focusable without lyrics and the focus engine does not adopt a pushed view's buttons |
| Denied auth re-offered a Connect button | tvOS returns the stored answer without prompting — it can only fail again |
| A failed search left the old results on screen | they read as an answer to the new query |
| The last line stayed lit for the whole outro | `gapState` returned "not instrumental" past the final line — the parked highlight where it lasts longest |

### Known gaps

- **MusicKit is unverified.** Auth, catalog search, playback, and the playhead
  have never run — the simulator cannot exercise them. Everything downstream of
  `MusicPlayerService.playbackTime` is proven via the demo clock, so the risk is
  concentrated in that one service.
- The live-simulator panel integration reports Xcode as unselected despite
  `xcode-select -p` being correct; fix with
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Screenshots
  via `xcrun simctl io <UDID> screenshot` work regardless.

## App Store notes

- Privacy: `NSAppleMusicUsageDescription` is set
- Screenshots: 1920×1080 and 3840×2160 Apple TV
- MusicKit usage must comply with [Apple Media Services terms](https://developer.apple.com/support/apple-music-api/)
- Do not ship provider API keys in the binary — keep scraping behind your Vercel proxies
