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
2. Explicit App ID **`com.bar4bar.tv`** with the **MusicKit App Service** enabled in Apple Developer → Identifiers. Do not add `com.apple.developer.music-kit` to the entitlements file: Apple rejects it during signing.
3. Xcode 15+ / tvOS 17+ SDK
4. [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
5. Optional: Vercel deploy of this repo for NetEase yrc / Musixmatch richsync (`LYRICS_API_BASE`)

### Pair the Apple TV before the first device build

Automatic signing cannot create a profile for a team with no registered devices,
and it fails with a message that reads like an account problem rather than a
setup step:

> Your team has no devices from which to generate a provisioning profile.

Registering the Apple TV happens by pairing it, which is **wireless only** —
there is no cable for this, and the TV must be on the same network as the Mac:

1. Apple TV → Settings ▸ Remotes and Devices ▸ Remote App and Devices
   (leave that screen open — it is what makes the TV discoverable)
2. Xcode → Window ▸ Devices and Simulators ▸ the Apple TV appears under
   *Discovered* → **Pair** → type the six-digit code shown on the TV

The UDID registers with the team on pairing, and the next build signs.

## Generate & run

```sh
cd tvos
xcodegen generate
open Bar4BarTV.xcodeproj
```

Select an **Apple TV** simulator or device, set your Development Team, then Run.

**Required once on this Mac:** install the **tvOS** platform / simulator runtime from Xcode → Settings → Platforms (or Components). Without it, `actool` fails with `No available simulator runtimes for platform appletvsimulator` even for device SDK builds.

Set `LYRICS_API_HOST` in [`tvos/Bar4BarTV/Config/Debug.xcconfig`](../tvos/Bar4BarTV/Config/Debug.xcconfig) to your Vercel **host** for word-level NetEase/Musixmatch via the existing proxies, and for Spotify pairing. Leave blank to use **LRCLIB only** (no secrets in the IPA).

> **Host only — no scheme.** `xcconfig` treats `//` as a comment with no escape,
> so writing `LYRICS_API_BASE = https://your-app.vercel.app` silently truncates
> the value to `https:`. That is not hypothetical: it is what shipped, and the
> lyric proxies looked configured while never once being reached. The file now
> takes a bare host and glues the scheme back on through a `SLASHES` variable,
> and `AppConfig.lyricsAPIBase` rejects any URL with no host so the same trap
> cannot go quiet again.

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
| `BAR4BAR_ROUTE` | `search` · `settings` · `karaoke` · `spotify` |
| `BAR4BAR_SEARCH` | any term — runs a real catalog search on launch |
| `BAR4BAR_FAKE_RESULTS` | `empty` · `loading` · `error` |
| `BAR4BAR_FAKE_PAIR` | a code, e.g. `K7M-3QP` — parks the pairing screen |

```sh
SIMCTL_CHILD_BAR4BAR_ROUTE=search \
SIMCTL_CHILD_BAR4BAR_SEARCH="ella langley" \
xcrun simctl launch <UDID> com.bar4bar.tv
```

Results no longer need faking: browse runs on the public iTunes feeds, so the
hub shelves and the search grid fill with real artwork in the simulator.
`BAR4BAR_FAKE_RESULTS` survives only for the three states the network will not
produce on demand.

## Browse without MusicKit

The hub and search are fed by [`Bar4BarCore/CatalogClient.swift`](../tvos/Bar4BarCore/Sources/Bar4BarCore/CatalogClient.swift):
the iTunes charts RSS and the iTunes Search API, the same public, keyless feeds
the web hub uses in `app/recommendations.js`.

This matters beyond "it renders in the simulator". Sourcing browse from MusicKit
meant a viewer with no Apple Music subscription saw an empty app, and it meant
every browse surface was unverifiable on the only machines that can display
them. MusicKit is now consulted at exactly one moment — pressing play.

The handoff is exact rather than fuzzy: the chart feed's `im:id` and Search's
`trackId` are both the **Apple Music catalog id**, so `MusicPlayerService.resolve`
looks the song up by id and only falls back to a title match for items that
arrived without one.

## Spotify follow (tvOS)

The Apple TV never plays Spotify audio — it follows it. `/me/player/currently-playing`
reports what the account is playing on *any* device, so a phone or a HomePod
drives the lyrics on the television.

tvOS has no browser, no `ASWebAuthenticationSession`, and Spotify has no
device-code flow, so authorization runs as a pairing handshake through this
repo's own deployment ([`lib/tv-pair.mjs`](../lib/tv-pair.mjs), [`api/tv-pair.js`](../api/tv-pair.js)):

1. TV → `POST /api/tv-pair?action=start` → `{ code: "K7M-3QP", pollToken }`
2. TV shows the code; you open `/tv` on a phone and type it in
3. phone → `/api/tv-pair?action=authorize&code=…` → 302 to Spotify
4. Spotify → `?action=callback` → PKCE exchange, tokens stored against the code
5. TV → `?action=poll&token=…` → the tokens, **once**, then the record is destroyed

PKCE throughout: no client secret anywhere, and the client id never reaches the
device (refresh is proxied for the same reason). The refresh token lives in the
tvOS Keychain.

**Requires a shared store.** The TV and the phone are different lambdas, so the
handshake needs somewhere both can see. [`lib/pair-store.mjs`](../lib/pair-store.mjs)
takes whichever is configured — it holds ~200 bytes for ten minutes, so this
should never be a vendor decision, and free tiers move around (Upstash dropped
theirs):

| Backend | Env | Setup |
|---|---|---|
| Supabase | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | run [`docs/tv-pairing-store.sql`](tv-pairing-store.sql) once |
| Upstash-protocol REST KV (Vercel KV, Upstash) | `KV_REST_API_URL` + `KV_REST_API_TOKEN` | bind the integration |
| memory | — | `npm run dev` only |

The table holds a Spotify refresh token for the seconds between the phone
finishing OAuth and the TV's next poll, so the SQL turns RLS on with **no
policies** and revokes anon/authenticated outright — only the service-role key,
which never leaves the server, can touch it.

With no store bound, the `start` response carries `durable: false` and the TV
warns on screen instead of showing a code that can never be redeemed. To see
which backend a deployment actually picked up:

```sh
curl -s "https://YOUR-PROJECT.vercel.app/api/tv-pair?action=start"
# → {"code":"K7M-3QP", … ,"durable":true,"backend":"supabase"}
```

Add `https://YOUR-PROJECT.vercel.app/api/tv-pair?action=callback` to the Spotify
Dashboard's Redirect URIs.

The playhead goes through `StreamingClock`, not straight to the display:
Spotify reports `progress_ms` about once a second with network jitter on top,
and driving the word wipe off that raw would make every word twitch.

## Song structure

[`Bar4BarCore/Sections.swift`](../tvos/Bar4BarCore/Sources/Bar4BarCore/Sections.swift)
is the Swift port of `app/providers/formats/sections.js` — chorus-vs-verse from
repeated passages, instrumental breaks from long gaps, and nothing finer,
because repetition supports no finer claim. The karaoke rail draws it: sung
sections solid, instrumental ones hollow, the current one raised.

The rail hides itself when a song yields fewer than two sections, which is the
honest answer for anything short or without repetition.

## Product cut line

| On Apple TV (v1) | Stays on Mac Electron |
|------------------|------------------------|
| Apple Music (MusicKit) playback + playhead | Vinyl / mic / AcoustID / ACRCloud |
| **Spotify follow (phone pairing)** | Forced align, vocal separation, Whisper |
| Catalog lyrics (LRCLIB + optional proxy) | Local audio file sync |
| Word wipe karaoke, sync nudge, singer lead | Music video / YouTube bed |
| Hub shelves + search + remote focus | OBS projector output |
| **Structure rail, art-adaptive accent** | Language aid (romanization) |

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
- [x] Phase 3.7 — **Parity with the Electron hub.** The tvOS hub was two cards on
      an empty ground because every browse surface was gated behind MusicKit;
      `CatalogClient` moved browse onto the public iTunes feeds, so shelves and
      search now carry real artwork with no account and no subscription. Adds
      Spotify follow via phone pairing, the structure rail (`Sections.swift`),
      artwork in the karaoke header, the B4B mark, persisted recents, and a
      connect prompt so pressing an unplayable song leads somewhere. Fixed the
      xcconfig `//` truncation that had disabled the lyric proxies outright.
      Core tests 39 → 65.
- [x] Phase 4 (sprint 2) — **Cinematic stage, ambient hub, remote gestures, violet theme.**
      Full 60fps karaoke stage (`PhraseStage.swift`, TimelineView).
      `CinematicStageFX`: stage beams, word-kick flash, anthem rays, chorus drop plate.
      `StageLightClock`: eased cinematic lighting transitions per section.
      Swipe gestures: swipe-left = replay current line, swipe-right = skip to next chorus.
      Instrumental countdown overlay ("BACK IN Xs" + next line preview, last 8s of gap).
      3-line ghost runway (next 3 lines at 42%/30%/22% font size).
      Line-start cue dot: 12pt → 4pt shrink as line settles.
      Section label pill: VERSE/CHORUS/BUILD/INSTRUMENTAL fades in at section boundary for 3s.
      `HubView` ambient environment: 30fps Halton particles, artwork bloom, EQ bars,
      now-playing strip. Violet/teal theme (`accentStatic = #8B5CF6`,
      `Glass.meter/holdHorizon = #00EDFF`). `AccentPalette`: per-song accent from
      artwork dominant color. Hold bar upgraded to progress-filling Capsule.
      `WordWipeView` filament mode: whole-glyph color heat + word-land flash.
      `AudioAnalyzer` crash fix: `startTap()` is now a no-op (Apple Music holds
      the audio HAL on tvOS; AVAudioEngine tap throws an Obj-C exception).
      Vocal isolation explicitly not implemented: Apple Music DRM pipeline blocks
      AVAudioEngine on tvOS; would require a licensed instrumental API.
      Signed device build on `Bedroom` confirmed (2026-09-11); MusicKit runtime
      still needs one awake-device pass. Spotify consent exchange deployed and
      durable (Supabase), final token exchange unverified by a human.
- [ ] Phase 5 — remaining features:
      blank-a-word practice mode (hide every Nth word as ___);
      end-of-song performance stats (lines sung / total);
      loop section; party mode "YOUR TURN" flash; dense line indicator for
      fast/rap sections; TestFlight; App Store screenshots; ToS review for
      lyric proxies

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
| Music started with Siri stayed on the hub | automatic navigation was accidentally gated to Spotify follow mode |
| A Spotify podcast opened the song lyric failure state | the playback parser accepted episodes because their wire fields overlap with tracks |

### Known gaps

- **MusicKit runtime is unverified.** The app now compiles, signs, and installs
  on the paired physical Apple TV, but that TV was asleep when launch was
  attempted. Authorization, catalog resolution, playback, and the live
  playhead therefore still need one awake-device pass. Browse is public, so
  only `MusicPlayerService.resolve` and `play` are unproven, and everything
  downstream of `playbackTime` is exercised by the demo clock.
- **The Spotify consent exchange is unverified end to end.** The live endpoint
  is deployed and reported `durable: true`, backed by Supabase, on 2026-09-11.
  The state machine, the
  single-redemption guarantee, the expiry paths, the pairing page, and every
  endpoint are exercised locally; the one untested link is a person completing
  Spotify consent and the actual token exchange. The
  tvOS pairing screen is captured through `BAR4BAR_FAKE_PAIR`.
- The live-simulator panel integration reports Xcode as unselected despite
  `xcode-select -p` being correct; fix with
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Screenshots
  via `xcrun simctl io <UDID> screenshot` work regardless.

## App Store notes

- Privacy: `NSAppleMusicUsageDescription` is set
- Screenshots: 1920×1080 and 3840×2160 Apple TV
- MusicKit usage must comply with [Apple Media Services terms](https://developer.apple.com/support/apple-music-api/)
- Do not ship provider API keys in the binary — keep scraping behind your Vercel proxies
