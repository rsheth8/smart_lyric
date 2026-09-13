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

`project.yml` is the source of truth for the Xcode project (`brew install xcodegen`).
Debug builds accept `-room ABCDEFGH` as a launch argument to pin the phone room code.

Siri Remote while singing: play/pause, left/right nudges timing by 0.1s, Menu goes back.
