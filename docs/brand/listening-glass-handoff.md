# Listening Glass — swarm agent handoff

**Status:** approved direction, not yet implemented  
**Surface:** native tvOS performance stage only (v1)  
**Supersedes on stage:** after-dark typographic installation (`docs/brand/tv-design-direction.md`, `PosterEnvironment`, cropped Fraunces graffiti)  
**Does not supersede:** clock → timeline → display contract, timing honesty, choreography sidecar, Spotify follow, MusicKit, desktop/Electron Dark Luxury  
**Room this is designed for:** dark stereo triangle, TV as lamp between speakers, warm rack light. Photograph from the couch with house lights off.

Paste this to every agent before they touch code:

```
Read docs/brand/listening-glass-handoff.md in full before editing.
You own only the work package named in your prompt (WP-1 … WP-8).
Do not edit files listed under another package.
Do not invent a new visual theme, palette, or motion language.
Do not add fonts, particles, lyric blur, fake BPM, or music-video beds.
If a decision is listed under Open questions, stop and report — do not guess.
Keep PhraseDirector, AudienceAccent, DisplayMath.wipeProgress, and remote UITest identifiers working unless your package explicitly replaces them.
```

---

## 1. North star

The Apple TV is the **third component in a hi-fi stack**: a sealed glass instrument between two speakers. It is functional art — mesmerizing to stare at, still singable from the couch.

Not a karaoke overlay. Not a magazine. Not the after-dark Fraunces installation. Not Dark Luxury gold-on-espresso.

**Job of each layer**

| Layer | Job |
| --- | --- |
| Color field | Mesmerize. Light the room. Tell section without captions. |
| Filament line | The only thing you read. Frozen size at phrase entrance. |
| Edge meters | Prove it is audio equipment. Onset, hold, Cheer, Take turns L/R. |
| Faceplate legend | Artist · title · elapsed. Identity without app chrome. |
| Sleeve in glass | Intros and instrumentals only — an object, not a UI card. |

---

## 2. Non-goals (v1)

- Hub / Search / Settings visual rewrite (Phase 2).
- Desktop / web / OBS overlay restyle.
- New font files. Keep bundled Manrope for lyrics. Fraunces may remain registered for hub until Phase 2; **do not draw it on the performance stage**.
- Meter Blue or Phosphor looks (Phase 2 intensity cousins).
- SharePlay, Top Shelf content, Siri, iPhone listener behavior (QR may stay in Timing).
- Pitch scoring, particles, neon, lyric blur, always-on video bed, resizing the reading line mid-phrase.
- Fake BPM. Word onset, hold, section, pause, Cheer are the only clocks.

---

## 3. Invariants — do not break

These are already tested. A PR that regresses them is rejected.

1. **Display never reads audio.** `TimelineView` samples `music.liveTime` + `session.totalAlignment` + `session.singerLead`. Same `StageSample` as today.
2. **Phrase size freezes at entrance.** Timing revisions change word bounds, not type size, wrapping, or text. `PhraseRuntime` / `PhraseFitting` stay.
3. **Revealing the deck cannot move the lyric band.** `KaraokeLayout.lyricTop/Bottom` independent of `chromeVisible`.
4. **Song clock ≠ audience clock.** Pause freezes field/meter song motion. Cheer can still bloom a paused composition. `AudienceAccent` duration stays 1.2 s, coalesced, never edits lyrics.
5. **Honest timing.** Estimated words remain labeled. Catalog still says timing is checked on selection. Do not promise word sync from metadata.
6. **Reviewed choreography overrides automatic.** `.choreography.json` still requires matching `RecordingIdentity` + `lyricRevision`.
7. **No lyric blur.** Field may be a soft Canvas color volume. Words stay sharp.
8. **Reduce Motion:** freeze field drift and meter sway. Keep filament heat (color/brightness) and meter *color*. Hold still collapses the field via color, not motion.
9. **Essential words visible at onset and after seek.** Entrance mask that hides glyphs is forbidden on Glass. `StagePresentation.entrance` may stay in the director for other cues; the Glass renderer treats onset as filament = on.
10. **Demo lyrics stay original.** Never bundle catalog lyrics.
11. **Accessibility identifiers** used by UITests must keep working: `currentPhrase`, `stageCheer`, `stageView`, `showPlaybackControls`, `Hide controls`, `transportPlayPause`, `moreOptions`, `singerHandoff`, `phraseRole` (see WP-6 if you hide role chrome — then update tests in the same PR).
12. **4K performance.** No `blur` filters on television-size views. No full-panel `AsyncImage` except instrumental sleeve at ≤ 0.55 opacity, `scaledToFill`, no blur. Canvas stipple/outlines of the old installation are removed from the live stage.

---

## 4. Visual system

### Palette (stage only)

Add a namespace `Tokens.Glass` in `tvos/Bar4BarTV/Theme/Theme.swift`. Do not delete existing Tokens until Hub is restyled.

| Token | Hex | Use |
| --- | --- | --- |
| `envelope` | `#0C0A08` | Warm black glass, idle |
| `fieldFallback` | `#3A2418` | Tungsten volume when artwork has no hue |
| `filament` | `#F4E6D0` | Current / sung word |
| `filamentDim` | `#F4E6D0` @ 0.28 | Upcoming words on the same line |
| `filamentSung` | `#F4E6D0` @ 0.62 | Words already sung — stay warm, not “grey leftover” |
| `meter` | `#3D6CFF` | The only cool color. McIntosh-ish, never fill the panel |
| `legend` | `#F4E6D0` @ 0.45 | Faceplate type |
| `holdHorizon` | `#3D6CFF` @ 0.85 | 3 pt underline under a held word |

Artwork field: **new** `GlassMath.field(dominant: RGB) -> RGB?` in Bar4BarCore (do not reuse `AccentMath.targetL = 0.82` — that is button-bright).

```
OKLCh: L = 0.22 ... 0.32 (lerp with iris)
       C = clamp(artC, 0.035, 0.070)
       H = artwork hue
Fallback if art chroma < 0.035: fieldFallback
Contrast: filament vs envelope must stay ≥ 4.5. Field is a background volume; do not put small type on it.
```

Demo sleeve dominant is `DemoSong.artworkDominant` (`#8C6A1F`). Glass field for the demo must come out **warm**, not purple. Add a unit test: rebuilt hue within 20° of 55–90° (tungsten/gold), L < 0.40.

### Type

- Lyrics: existing `Tokens.lyric` / Manrope. Centered. Optical size from `PhraseFitting` with a **higher floor**: minimum **64 pt** on Glass (was 44). Long Spanish fixture must still fit the band — if it cannot at 64, drop to 56, never below 52. Record the chosen floor in a test.
- Faceplate legend: Manrope, 22–26 pt, tracking +2…+3, centered.
- Ghost next line: same face, 0.42× current size, opacity 0.35, centered under current. Take turns may tint ghost with a 2 pt left or right meter tick, not “SIDE B” at 13 pt.
- Do not use Fraunces, editorial italic invitations, or cropped outline graffiti on this stage.

### Layout (1920 × 1080 reference)

Optical center sits between the speakers — **centered**, not left-aligned.

```
x: 0          8%         50%                    92%        100%
   [meter L]  [          glass field            ]  [meter R]

y: 0
   12%   faceplate is NOT here
   38–62%  CURRENT LINE  (vertical center of panel, not the old 175 pt top pad)
   +48 pt  ghost next / language aid (aid wins if on; else ghost)
   88%     faceplate: ARTIST  ·  TITLE  ·  M:SS
   100%
```

- Meter columns: 8% width each, full height, soft Canvas bars, not skeuomorphic needles in v1.
- Current line: max width 70% of panel (leave meters + overscan). Horizontal center.
- Safe inset still `Tokens.safeX = 96`, `safeY = 54` — meters sit *inside* the safe area, not in overscan.
- Chrome deck, when visible, is a bottom plate that **must not** change the current line’s frame (`KaraokeLayout` contract).

Kill on idle stage (controls hidden): BrandLockup, intensity label, “Press to show controls”, YOUR STAGE, VERSE, 04/09, BAR BY BAR, UP NEXT newspaper column, leftover installation letters.

Keep while idle: field, meters, filament line, ghost next, faceplate legend, language aid if enabled, estimated-word treatment (slightly lower filament heat, not a caption).

---

## 5. Behavior contract (pure math)

New file: `tvos/Bar4BarCore/Sources/Bar4BarCore/GlassMath.swift`  
New tests: `tvos/Bar4BarCore/Tests/Bar4BarCoreTests/GlassMathTests.swift`

`PhraseDirector.advance` stays the source of `StagePresentation`. Glass **derives** a `GlassField` from that plus intensity, party mode, cheer amount, reduceMotion, and artwork RGB. Do not fork a second director.

```swift
public struct GlassField: Equatable, Sendable {
  public var iris: Double          // 0 collapsed … 1 open
  public var warmth: Double        // 1 verse tungsten … 0 hook cooler
  public var envelope: Double      // idle lamp brightness
  public var leftMeter: Double     // 0 … 1
  public var rightMeter: Double
  public var sleeve: Double        // instrumental artwork 0 … 1
  public var breath: Double        // pre-vocal blackout 0 … 1
  public var cheer: Double         // 0 … 1 from AudienceAccent.amount
  public var hold: Double          // 0 … 1
}

public enum GlassMath {
  public static func field(
    state: StagePresentation,
    intensity: StageIntensity,
    partyMode: String,            // "Solo" | "Take turns" | "Everyone"
    sideA: Bool,                  // current line even index → true
    cheer: Double,
    playing: Bool,
    reduceMotion: Bool,
    nextVocalIn: Double?,
    inLongGap: Bool
  ) -> GlassField
}
```

### Formulas (clamp every output to 0...1)

**iris**

```
base = intensity == .focus ? 0.18 : intensity == .live ? 0.48 : 0.72
section = chorus || finale ? 0.20 : instrumental ? 0.04 : 0.00
iris = (base + section) * (1 - 0.82 * hold) * (1 - breath) + 0.22 * cheer
```

Pause: freeze `iris` at last playing value except cheer still adds (same as song-clock freeze in PhraseDirector — pass `playing` and do not ease iris on pause). Implement freeze inside the *view runtime* the same way `PhraseRuntime` freezes, or by using `state.sectionTransition` which already freezes. Do not keep a second clock in GlassMath if you can derive from `state`. Simplest: GlassMath is stateless per frame; PhraseDirector already freezes section/motion on pause. For iris base, use `state` + intensity + hold + cheer only.

**warmth**

```
target = verse || build ? 1.00 : chorus ? 0.32 : finale ? 0.18 : 0.55
warmth = lerp(previousTarget, target, state.sectionTransition)
```

Derive previousTarget from `state.previousKind`. Stateless.

**hold**

```
hold = state.hold != nil ? 1 : 0
```

(Director already gated estimated tails.)

**breath**

Reuse `StageLookMath.breathWindow` (0.40) and `inLongGap`. If `inLongGap`, `nextVocalIn` in (0, 0.40], `breath = 1 - nextVocalIn/0.40`. Else 0. Reduce Motion: still allow breath as brightness, no other motion.

**sleeve**

```
sleeve = (state.kind == .instrumental || (state.countdown ?? 0) > preview) ? 0.50 * (1 - breath) : 0
```

Preview seconds still come from `session.previewSeconds`. Pass them in if needed (`countdown > preview` is already how the director marks instrumental). Using `state.kind == .instrumental` is enough.

**meters**

```
energy = 0.10 + 0.40 * (state.impact) + 0.50 * cheer + 0.25 * hold
left  = energy
right = energy
if partyMode == "Take turns" {
  if sideA { left += 0.22; right *= 0.45 }
  else     { right += 0.22; left *= 0.45 }
}
```

Pause: `state.impact` already dies with the director when playing is false (emphasis age). Word-impact kick should still be derived: either pass `StageDirection.wordImpact(...)` into GlassMath or add `impact` from presentation (already `state.impact` for reviewed emphasis only).

**Word onset kick:** `state.impact` today is reviewed-emphasis only. For meters we want *every* word onset. Pass `wordKick = StageDirection.wordImpact(lines:t:activeLi:)` from the view (already exists, unused on PhraseStage). GlassMath:

```
energy = 0.10 + 0.40 * wordKick + 0.50 * cheer + 0.25 * hold
```

**envelope**

```
envelope = playing ? (0.20 + 0.55 * iris) : (0.16 + 0.20 * cheer)
```

**Filament heat per word** (view-side, using existing `DisplayMath.wordPhase` + `wipeProgress`):

| Phase | Heat |
| --- | --- |
| upcoming | 0.22 |
| current | 0.38 + 0.62 * wipeProgress — applied as **opacity/brightness of the whole glyph**, not a left-to-right mask |
| sung | 0.58 |
| current + hold | 1.00 |

No L-R wipe on Glass. The letter gets hotter as a unit. That is the hi-fi filament. Keep `DisplayMath.wipeProgress` as the 0…1 clock; change only how it is **rendered**.

Estimated current words: multiply heat by 0.75 and do **not** draw the hold horizon unless provenance is hold-cue or reliable duration ≥ 1.8 s (already in the director).

### Motion budget

- Field drift: period ≥ 18 s, amplitude small, **off** when `reduceMotion` or `intensity == .focus` or paused.
- Filament heat: follows wipe clock (hundreds of ms to seconds). Allowed under Reduce Motion.
- Cheer bloom: 1.2 s (`AudienceAccent`). Envelope + iris + meters. No letter slam, no invert of the reading line (invert would wreck singability). Field may lift; glyphs stay same position.
- Hook: iris + warmth only. No 200 pt title-card overlay in v1 (that was a previous brainstorm; out of scope so v1 photographs as one system).
- Hold: iris collapse + envelope drop + hold horizon. The rest of the line stays, dimmed. Do not hide upcoming words on the same phrase (singer still needs them).

---

## 6. Architecture

```
Bar4BarCore (pure, unit-tested)
  PhraseDirector        — unchanged source of StagePresentation
  StageDirection        — hold, wordImpact, afterglow, gaps
  StageLookMath         — reuse breath + inLongGap only
  AudienceAccent        — unchanged
  AccentMath            — leave for hub/buttons
  GlassMath             — NEW field derivation
  GlassMath.field(dominant:) — NEW dim volume from artwork hue

Bar4BarTV
  PhraseStage           — swap PosterEnvironment → ListeningGlass; center the line
  ListeningGlass.swift  — NEW Canvas field + meters (app target)
  FilamentLine.swift    — NEW or WordWipeView mode: whole-glyph heat
  KaraokeView           — idle chrome stripped; Menu/Cheer grammar
  Theme.swift           — Tokens.Glass
  StageNight.swift      — wire PictureArtwork + EntrancePlate into Glass sleeve/breath
  StageSettingsPanel    — copy only: Focus/Live/Headliner describe field energy, not “exhibition studies”
```

**Dead on the live stage (do not call from PhraseStage / KaraokeView.performance):**

- `PosterEnvironment` / `InstallationForms` outlines
- `CinematicStageFX`, anthem rays, haze beams
- `ListeningRoomBackdrop` on the karaoke canvas (Settings may keep it until Phase 2)
- `RoomLyrics` ladder
- `KaraokeView.songIdentity()` until sleeve-in-glass uses `PictureArtwork` directly

Leave the unused files in the tree for Phase 2; do not delete in v1 unless your package is a dedicated cleanup and tests stay green.

Controls and focus remain **siblings, never children** of `TimelineView`. Same as today’s PhraseStage comment.

---

## 7. Work packages

Run **WP-1 and WP-2 in parallel**. WP-3 and WP-4 in parallel after WP-1/2. WP-5 needs 3+4. WP-6 can start after WP-5’s layout lands (identifiers). WP-7 after WP-5. WP-8 last.

### WP-1 — GlassMath (Core)

**Owner files**

- add `tvos/Bar4BarCore/Sources/Bar4BarCore/GlassMath.swift`
- add `tvos/Bar4BarCore/Tests/Bar4BarCoreTests/GlassMathTests.swift`

**Do not edit** PhraseDirector unless a field cannot be derived (prefer not to).

**Tests required**

- iris: focus < live < headliner at identical state
- chorus raises iris vs verse
- hold drops iris by ≥ 50%
- pause: sectionTransition freeze still comes from director (call director then GlassMath)
- Take turns even line → left > right; odd → right > left
- cheer adds to meters while `playing == false`
- breath: `nextVocalIn = 0.2`, `inLongGap == true` → breath > 0.4
- sleeve > 0 iff kind == instrumental
- `field(dominant: DemoSong.artworkDominant)` warm (hue 40…100°), L < 0.40
- greyscale art → fallback, not nil crash
- Reduce Motion is a view concern; math still returns breath/hold

**Done when** `swift test --package-path tvos/Bar4BarCore` includes the new file and existing PhraseDirector tests still pass.

### WP-2 — Tokens.Glass

**Owner files**

- `tvos/Bar4BarTV/Theme/Theme.swift` (additive)

**Done when** `Tokens.Glass.envelope/filament/meter/legend/holdHorizon/fieldFallback` exist. No view swap yet.

### WP-3 — ListeningGlass renderer

**Owner files**

- add `tvos/Bar4BarTV/Views/ListeningGlass.swift`
- `tvos/Bar4BarTV/Views/PhraseStage.swift` (replace `PosterEnvironment` only)

**Implementation notes**

- `Canvas` fills: envelope, then one or two large soft ellipses in field color at opacity tied to `iris` (no SwiftUI `blur` filter). Optional slow drift of ellipse center using `state.motionTime` when playing && !reduceMotion && intensity != .focus.
- Left/right meter: rounded rects, fill `Tokens.Glass.meter` at `leftMeter`/`rightMeter` height from bottom.
- Cheer: raise ellipse opacity using `cheer`; do not move glyphs.
- `allowsHitTesting(false)`, `accessibilityHidden` on the field layer.
- Artwork URL is **not** drawn here except via WP-7.

**Done when** demo stage no longer shows cropped title initials. Simulator screenshot from `BAR4BAR_AUTODEMO=1` is a dark warm field, not purple aubergine.

### WP-4 — Filament words

**Owner files**

- `tvos/Bar4BarTV/Views/KaraokeView.swift` (`WordWipeView` / `LyricLineView`) **or** new `FilamentLine.swift` used only by PhraseStage
- Prefer a `renderMode: .wipe | .filament` so Stage settings preview does not fork two word views carelessly. Default the **live PhraseStage** to `.filament`. Settings preview may follow.

**Rules**

- Whole-glyph heat, no L-R mask, no 8% scale punch, no print-shadow offset on Glass.
- Hold: 3 pt meter-blue horizon under that word only; extra vertical reserve already in PhraseFitting (keep it).
- Estimated: 0.75 heat, no horizon.
- `transaction { $0.animation = nil }` stays (clock-driven).

**Done when** demo held note at t ≈ 23.5 visibly *stays bright for the hold* rather than wiping left-to-right. Upcoming words on the line remain readable (≥ 0.22 heat).

### WP-5 — Centered phrase board

**Owner files**

- `tvos/Bar4BarTV/Views/PhraseStage.swift`
- `tvos/Bar4BarTV/Views/KaraokeLayout.swift` (adjust lyric band to vertical center if needed; chrome still must not move it)
- `tvos/Bar4BarTVTests/KaraokeLayoutTests.swift`

**Layout**

- Remove role row, section title, 04/09, BAR BY BAR, UP NEXT block, NEXT VOICE 13 pt.
- Current phrase: centered, identifier `currentPhrase` kept.
- Ghost next line under it. In Take turns, if you remove `singerHandoff`, **WP-6/8 must rewrite** `testIncomingSingerCaptionPreservesActivePhraseAndFocus`. Replacement: ghost line + L/R meter bias; test that `currentPhrase.frame` is unchanged after switching to Take turns.
- Language aid: under current line, opacity 0.5, max 2 lines, identifier unchanged if one exists.
- Padding: abandon `padding(.horizontal, 175)` / `.top, 175` / `.bottom, 240`. Use centered frame in the lyric band.

**Type floor** 64 pt (or 56 if the Spanish fixture overflows). Update PhraseFitting call sites. Long-line tests must be updated, not deleted.

### WP-6 — Idle chrome + remote grammar

**Owner files**

- `tvos/Bar4BarTV/Views/KaraokeView.swift`
- `tvos/Bar4BarTVUITests/RemoteNavigationTests.swift`

**Idle (controls hidden)**

- No lockup, no intensity word, no “Press to show controls”.
- Faceplate legend (artist · title · elapsed) lives in PhraseStage/ListeningGlass, not the overlay that currently sits in `performance`.
- Catcher `showPlaybackControls` remains for first Select if you do **not** implement Select-as-Cheer in v1.

**Remote grammar (v1 required)**

| Input | Behavior |
| --- | --- |
| Menu, chrome hidden | Show controls (today) |
| Menu, chrome visible | **Hide controls** (today this pops to Home — **change it**) |
| Menu, chrome visible, second press | Home / clear stack |
| Select on catcher | Show controls in v1. Optional follow-up: Cheer. Do not ship Select-as-Cheer without updating UITests in the same PR. |
| Play/Pause hardware | Toggle transport. Prefer **not** forcing the deck if already hidden. |
| Cheer button | Unchanged identifier `stageCheer`. Presentation is meter/field bloom. |

**Faceplate elapsed** uses audible time, monospaced, `m:ss`. Demo shows elapsed of the 52 s loop.

**Stage settings copy** (same PR or WP-5):  

- Focus → “Quiet field. Words only.”  
- Live → “Glass lamp. Slow field.”  
- Headliner → “Open iris. Holds kill the room.”  

Keep `intensity-focus|live|headliner` identifiers.

### WP-7 — Sleeve and breath

**Owner files**

- `tvos/Bar4BarTV/Views/StageNight.swift` (`PictureArtwork`, `EntrancePlate`)
- `tvos/Bar4BarTV/Views/ListeningGlass.swift` or PhraseStage

**Behavior**

- `GlassField.sleeve > 0.05`: `PictureArtwork` in the glass, opacity `0.22 + 0.33 * sleeve`, no blur, slow drift off under Reduce Motion.
- `breath > 0`: dim field toward envelope (multiply iris). First word after breath uses filament heat = on at onset (invariant 9).
- Long intro (`StageDirection.entranceIsFullCard`): optional compact EntrancePlate **behind** the field at low opacity. Do not cover the first sung line. If vocals start < 1.2 s, skip the plate.

Demo has a 4.6 s gap after line 1 — this must photograph as sleeve/field, not an empty lyric page.

### WP-8 — Verify, captures, tests

**Commands**

```sh
cd tvos/Bar4BarCore && swift test
cd tvos && xcodegen generate
xcodebuild -project Bar4BarTV.xcodeproj -scheme Bar4BarTVTests \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation) (at 1080p)' \
  CODE_SIGNING_ALLOWED=NO test
xcodebuild -project Bar4BarTV.xcodeproj -scheme Bar4BarTVUITests \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation) (at 1080p)' \
  CODE_SIGNING_ALLOWED=NO test
```

**Demo frames to capture** (launch env already documented in `docs/tvos-migration.md`)

| Seek | Must show |
| --- | --- |
| 0.2 | Warm envelope, faceplate, little or no type |
| 3.0 | Centered filament line, meters alive |
| 10.5 | Instrumental sleeve in glass |
| 23.5 | Hold: field collapsed, one bright word, blue horizon |
| 29.4 | Take turns meter bias if enabled |
| 32.9 | Dense/fast line still readable, no wipe gimmick |
| 50.5 | Afterglow: last line stays, field idle — not leftover captions |

Store captures under `docs/quality/listening-glass/` (new folder). Do not overwrite `docs/quality/installation/` until this theme is accepted on the physical TV.

**Physical TV (human, not agents)**

Lights off, same stereo triangle. If the panel still looks purple or the type is small between the speakers, fail the visual — do not “tune in code” by adding more captions.

---

## 8. File collision map

| File | WP |
| --- | --- |
| `Bar4BarCore/.../GlassMath.swift` | 1 |
| `Bar4BarCore/Tests/.../GlassMathTests.swift` | 1 |
| `Theme/Theme.swift` | 2 |
| `Views/ListeningGlass.swift` | 3, 7 |
| `Views/PhraseStage.swift` | 3, 5, 7 |
| `Views/KaraokeView.swift` | 4 (WordWipeView), 6 (chrome/remote) — **serialize 4 then 6 or split FilamentLine.swift** |
| `Views/KaraokeLayout.swift` + tests | 5 |
| `Views/StageNight.swift` | 7 |
| `Views/StageSettingsPanel.swift` | 6 (copy) |
| `Bar4BarTVUITests/RemoteNavigationTests.swift` | 6, 8 |

**Avoid a merge fight on KaraokeView:** WP-4 should extract `FilamentLine.swift` / `WordWipeView` into its own file first, then WP-6 only touches `KaraokeView` chrome.

---

## 9. Copy deck (stage)

Idle faceplate: `{ARTIST}  ·  `{TITLE}  ·  `{m:ss}`  
Demo: `BAR4BAR  ·  BAR FOR BAR  ·  0:23`  
Estimated current line: no caption if heat already encodes it; if QA needs a signal, a 2 pt legend `APPROX` at faceplate trailing edge, not a 16 pt banner.  
Cheer is unnamed on screen.  
Do not write “Experience”, “Choose your atmosphere”, “BAR BY BAR”, “YOUR STAGE”.

---

## 10. Definition of done (v1)

- [ ] PhraseStage uses ListeningGlass; no installation initials on the demo.
- [ ] Centered filament line, ghost next, faceplate legend.
- [ ] Hold at demo 23.5 collapses the field; word stays put.
- [ ] Instrumental gap shows sleeve, not empty UI.
- [ ] Menu hides chrome before leaving Home.
- [ ] Pause freezes the field; Cheer still blooms meters.
- [ ] Reduce Motion: no drift, heat + color remain.
- [ ] Core + app + UITests green on 1080p TV 4K simulator.
- [ ] Captures in `docs/quality/listening-glass/`.
- [ ] Hub still works (unchanged). No font bundle change.
- [ ] Physical-TV photo from the couch (human). Pass = looks like it belongs next to the speakers.

---

## 11. Phase 2 (do not start in v1)

- Hub as a dark rack of sleeves (`PosterCard` at 260 pt). First-run vs returning.
- Settings off `ListeningRoomBackdrop`.
- Meter Blue and Phosphor as named looks mapped from Focus/Live/Headliner **or** replacing them.
- Select-on-glass = Cheer; swipe-up or long-press for deck.
- Desktop/web adopts Glass or is formally split as “workshop”.
- Top Shelf marquee of last field + legend.
- Hook title-card overlay (1.8 s `chorusDrop`) — only after Glass photographs well.

---

## 12. Open questions — agents must not guess

1. Select-on-empty-stage = Cheer in v1, or keep Select = show deck? **Default: show deck** (safer for UITests). Flag in WP-6 if you implement Cheer-on-Select.
2. Type floor 64 vs 56 on the Spanish fixture. Measure; do not invent a third board layout.
3. Whether `phraseRole` / `singerHandoff` identifiers are deleted or become hidden accessibility-only. Prefer hidden accessibility labels so VoiceOver still announces “Side B in 3 seconds.”
4. Physical TV HDR bloom of meter blue — if it halos, lower meter opacity, do not add blur.

---

## 13. Suggested agent prompts

**WP-1**

```
Implement WP-1 from docs/brand/listening-glass-handoff.md.
Add GlassMath + GlassMathTests only. Do not touch SwiftUI.
Match the formulas in §5 exactly. Run swift test --package-path tvos/Bar4BarCore.
```

**WP-2**

```
Implement WP-2 from docs/brand/listening-glass-handoff.md.
Add Tokens.Glass to Theme.swift only. Do not retarget existing views.
```

**WP-3** (after 1–2)

```
Implement WP-3 from docs/brand/listening-glass-handoff.md.
Create ListeningGlass.swift and swap it in for PosterEnvironment in PhraseStage.
Do not reflow the phrase board (WP-5). No blur filters.
```

**WP-4** (after 2)

```
Implement WP-4 from docs/brand/listening-glass-handoff.md.
Extract FilamentLine from WordWipeView. PhraseStage uses filament heat (whole glyph, no L-R wipe).
Do not change KaraokeView chrome.
```

**WP-5** (after 3–4)

```
Implement WP-5 from docs/brand/listening-glass-handoff.md.
Center the phrase, kill role/section/UP NEXT chrome, keep currentPhrase identifier and frozen sizing.
Update KaraokeLayoutTests. Coordinate singerHandoff with WP-6.
```

**WP-6** (after 5, or after 4 if FilamentLine is extracted)

```
Implement WP-6 from docs/brand/listening-glass-handoff.md.
Idle chrome off. Menu hides then leaves. Update RemoteNavigationTests in the same PR.
```

**WP-7** (after 5)

```
Implement WP-7 from docs/brand/listening-glass-handoff.md.
Wire PictureArtwork + breath using GlassField.sleeve and GlassField.breath.
Demo gap at ~10.5s must show the sleeve.
```

**WP-8** (after 6–7)

```
Implement WP-8 from docs/brand/listening-glass-handoff.md.
Run Core/app/UITest suites. Capture the demo seek table into docs/quality/listening-glass/.
Do not overwrite docs/quality/installation/.
```
