# Bar4Bar for Apple TV

A native SwiftUI lyric stage. Apple Music plays directly on the TV; Spotify follows
playback from a phone, speaker, or another Spotify device. Browse and the visual
demo work without connecting an account.

## Visual direction

The default is Bar4Bar's full-width lyric stage, with condensed poster lettering,
record-groove artwork, and warm light. Album view is optional. See the
[TV design direction](../docs/brand/tv-design-direction.md) for the visual and
interaction rules.

## Run

```sh
cd tvos
xcodegen generate
open Bar4BarTV.xcodeproj
```

Select **Bar4BarTV**, your developer team, and the Apple TV, then Run.

- App ID: `com.bar4bar.tv`. Enable **MusicKit under App Services** for this ID in
  Apple Developer. Native MusicKit generates its own token.
- Do **not** add `com.apple.developer.music-kit` to the entitlements file. Apple
  rejects this signing entitlement; it is not how the MusicKit App Service is enabled.
- Pair the TV in Xcode → Window → Devices and Simulators while the TV shows
  Settings → Remotes and Devices → Remote App and Devices.
- Keep the team ID and server host in `Bar4BarTV/Config/Debug.xcconfig` so project
  regeneration preserves them. The server setting takes a host, not an HTTPS URL.

## Verify

```sh
swift test --package-path Bar4BarCore
xcodebuild -project Bar4BarTV.xcodeproj -scheme Bar4BarTVTests \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation) (at 1080p)' \
  CODE_SIGNING_ALLOWED=NO test
xcodebuild -project Bar4BarTV.xcodeproj -scheme Bar4BarTVUITests \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation) (at 1080p)' \
  CODE_SIGNING_ALLOWED=NO test
```

If Swift reports a module-cache path from an old checkout, run
`swift package --package-path Bar4BarCore clean`, then retry.

The app tests cover accumulated sync adjustments, saved offsets, stale lyric
responses, clearing during fetch, and playback ownership. Remote tests exercise
entering the demo, play/pause, repeated timing changes, and pairing/back navigation.
Apple Music streaming must also be checked on a physical TV with a subscription.

## Spotify service

`https://smartlyric.vercel.app/api/tv-pair?action=start` must return HTTP 200 and
`durable: true`. A paused Supabase project can prevent both pairing and Vercel
builds; resume the existing project before redeploying. Run
[the pairing schema](../docs/tv-pairing-store.sql) once if `tv_pairings` is missing.

Register this exact Spotify redirect URI:

```text
https://smartlyric.vercel.app/api/tv-pair?action=callback
```

From the repository root, `node scripts/stage-tv-server.mjs` prepares a temporary
server deployment folder and prints its path. It includes web/API sources and a
minimal dependency manifest, excluding desktop ML packages, recordings, local
credentials, and Xcode builds. Deploy that folder with the existing Vercel project.
Use a deployment without moving the live alias first, verify pairing, then point
`smartlyric.vercel.app` at the verified deployment.

Full architecture and launch controls: [tvOS guide](../docs/tvos-migration.md).

### Choreographed stage

The stage now uses a fixed phrase board. Open **Stage** from the playback deck to
choose Focus, Live or Headliner, adjust read-ahead, or choose Solo, Take turns or
Everyone. The first stage visit presents an animated preview; the intensity is
remembered. Demo-only **Featured / Automatic** compares reviewed choreography with
estimated word guidance on the same original lyrics.

Reviewed resources use the versioned `.choreography.json` format described in
`docs/brand/tv-design-direction.md`. They require matching recording identity and
lyric text. The word guidance also works without a sidecar.

For deterministic simulator QA, the existing autodemonstration launch environment
can additionally set `BAR4BAR_SKIP_STAGE_SETUP=1` and
`BAR4BAR_STAGE_FIXTURE=long` (original Spanish text with English help). This does
not connect a live listener or exercise real audio alignment.

### After-dark installation

The native core journey now uses bundled Fraunces and Manrope, midnight aubergine,
vermilion/lilac and chartreuse hooks. Original cached CoreText letter silhouettes
and stippling replace the stage frame. Native vectors also supply icon/top-shelf
artwork (`swift scripts/build-installation-assets.swift` from repository root).
Six outlined SVG design studies live in `docs/brand/studies`.

The playback deck includes **Cheer**, a coalesced audience accent with a separate
presentation clock. It never changes lyrics or timing. Song effects freeze on
pause; audience input can still accent a paused composition. The test-only launch
variable `BAR4BAR_REDUCE_MOTION=1` exercises the same stationary presentation as
system Reduce Motion without changing simulator preferences.

See `docs/brand/tv-design-direction.md` and
`docs/quality/listening-room/choreographed-stage-verification.md` for the final
visual/timing boundaries and validation status. Participant singing and logo-hidden
recognition review are pending.
