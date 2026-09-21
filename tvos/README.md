# Bar4Bar for Apple TV

Native SwiftUI app (tvOS 17+). tvOS has no web view, so this is a real app that
talks to the same backend as the web TV: lyrics through `smartlyric.vercel.app/api/lyrics`
and LRCLIB, and the phone remote through the hosted relay. Phones pair with the
existing `companion.html` page.

- `Bar4Bar/` — the app: home shelves, search, phone pairing, full-screen lyrics.
- `Bar4BarKit/` — everything that isn't a view (lyric parsing, catalogs, relay protocol), ported from `app/`.

```bash
cd tvos/Bar4BarKit && swift test
```

```bash
cd tvos && xcodegen && open Bar4Bar.xcodeproj
```

`RemoteFlowTests` drives the app with the Siri Remote (tabs, shelves, the stage, pause,
a timing nudge, Menu back) and attaches a screenshot of every step to the result bundle:

```bash
cd tvos && xcodebuild test -scheme Bar4Bar -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation) (at 1080p)'
```

Look and motion live in `Bar4Bar/Design.swift`: colours, one set of animation curves, glass
panels, and artwork that is cached and pre-blurred, so the backdrop moves without a live blur.

## Hearing the room

The playhead is a `SyncClock`. Left alone it free-runs at 1.0 — the manual mode,
where the singer starts the track themselves during the count-in and straightens
it with the remote.

With a Continuity Mic (an iPhone nearby acting as the Apple TV's microphone,
tvOS 17+ and an Apple TV 4K 2nd gen or later), `SongDetector` fingerprints a few
seconds of room audio every 5s through the relay's `/api/identify` and feeds the
clock where the song actually is. The TV then syncs itself to *anything* audible
— Apple Music, Spotify, a turntable, a laptop across the room — and puts the
song on stage without anyone picking it. No DRM problem, because it is listening
to a room, not tapping a stream.

Needs `ACRCLOUD_HOST` / `ACRCLOUD_ACCESS_KEY` / `ACRCLOUD_ACCESS_SECRET` set on
the relay, never in the app bundle. With no mic or no credentials it falls back
to manual mode silently.

Measured tracking error (`SongDetectorTests`): exact on a 1.0x digital source,
bounded within +/-0.3s on a turntable running a few percent off.

## Scoring

With the mic on, the stage keeps a live score and puts a card up when the song
ends. `ScoreKeeper` is a port of app/score.js and the grades are the same five
strings, because the relay validates `song_scored` against the allowlist in
app/analytics.js and a rename on one side alone gets the event 400'd.

What it can measure is coverage: the timeline says a word is due, did a voice
arrive. It cannot measure tuning — that needs the track's own samples to compare
against, which is exactly what a DRM'd stream never hands over — so `pitch` is
nil and the card says what it scored rather than implying otherwise.

The other half is `RoomVoice`. One mic hears the music as well as the singer, so
a plain level gate would award a Superstar to an empty room with the stereo on.
Uncorrelated sources add in power, so the singer's own RMS is
sqrt(room² − music²), and the music alone is measurable because the timeline
says exactly when it expects no words — every gap between lines is a fresh look
at the room without anyone in it.

The card needs a mic, a finished song and an Apple TV before it appears, so
Debug builds take `-fakeScore 72` to stand one up for `RemoteFlowTests`.

## Hearing yourself

Phone Remote → **Hear yourself** plays the mic back through the TV, with
**Reverb** cycling Dry / Light / Big. It is fed from the same capture as the
fingerprint, not a second input on the mic, and it is off at every launch.

Two hazards, both policy in `Bar4BarKit/Monitor.swift` and unit-tested:

- **Feedback.** The mic hears the speakers it feeds. `FeedbackGuard` (a port of
  the web's) switches the monitor off after 0.9s of sustained level above 0.55.
- **Latency.** Past ~25ms a singer hears a slapback echo, and HDMI into a
  television is a slow path. The app reports what AVAudioSession admits to plus
  one capture buffer; it can't see the phone-to-TV hop or the television's own
  processing, so a clean verdict is a floor. It warns rather than refuses.

Capture on tvOS can't be asked for a format (`audioSettings` is unavailable),
so it arrives at the device's own rate. `RoomBuffer.adopt(sampleRate:)` makes
the fingerprint WAV and the monitor both say the true rate.

**Unverified:** none of this has made a sound yet. It needs an Apple TV 4K
(2nd gen+) with an iPhone as the Continuity Mic. `monitor_on` analytics carry
the latency verdict, so the first real sessions tell us how many TVs are too slow.

`project.yml` is the source of truth for the Xcode project (`brew install xcodegen`).
Debug builds accept `-room ABCDEFGH` as a launch argument to pin the phone room code,
and `-noMic YES` to skip the room mic — the UI tests use it, because the
microphone prompt steals the remote's focus whenever the Simulator's privacy
state resets.

Siri Remote while singing: play/pause, left/right nudges timing by 0.1s, Menu goes back.
