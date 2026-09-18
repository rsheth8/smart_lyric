import SwiftUI
import MusicKit

struct RootView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      HubView(path: $path)
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .search:
            SearchView(path: $path)
          case .karaoke:
            KaraokeView(path: $path)
          case .settings:
            SettingsView(path: $path)
          case .spotify:
            if AppConfig.spotifyFollowEnabled {
              SpotifyPairingView(path: $path)
            } else {
              HubView(path: $path)
            }
          }
        }
    }
    // Picking a song without Apple Music connected used to do nothing at all.
    // Browse is public now, so that press is easy to make and has to lead
    // somewhere — asking here, and then playing what they picked, is the whole
    // point of holding onto the item.
    .alert(
      "Connect Apple Music to play",
      isPresented: Binding(
        get: { music.connectPrompt != nil },
        set: { if !$0 { music.connectPrompt = nil } }
      ),
      presenting: music.connectPrompt
    ) { item in
      Button("Connect") {
        Task {
          if await music.connectAndPlayPrompted(item) {
            path.append(Route.karaoke)
          }
        }
      }
      Button("Play the demo instead") {
        music.connectPrompt = nil
        if !music.isDemo { music.startDemo() }
        path.append(Route.karaoke)
      }
      Button("Not now", role: .cancel) { music.connectPrompt = nil }
    } message: { item in
      Text("“\(item.title)” streams from Apple Music, which needs a subscription on this Apple TV. Browsing and the bundled demo work without one.")
    }
    .alert("Unable to start music", isPresented: Binding(
      get: { music.errorMessage != nil },
      set: { if !$0 { music.errorMessage = nil } }
    )) {
      Button("OK") { music.errorMessage = nil }
    } message: {
      Text(music.errorMessage ?? "Please try again.")
    }
    .overlay {
      if music.isStartingPlayback || music.isConnecting {
        ZStack {
          Tokens.scrim.ignoresSafeArea()
          VStack(spacing: 24) {
            ProgressView().scaleEffect(1.5).tint(Tokens.accentStatic)
            Text(music.isConnecting ? "Connecting Apple Music…" : "Starting your song…")
              .font(Tokens.display(28, .medium))
              .foregroundStyle(Tokens.text1)
          }
          .padding(60)
          .background(Tokens.surfaceSolid2, in: RoundedRectangle(cornerRadius: 28))
        }
      }
    }
    .animation(Tokens.Motion.chrome, value: music.isStartingPlayback)
    .animation(Tokens.Motion.chrome, value: music.isConnecting)
    .onAppear { presentKaraokeIfNeeded() }
    .onChange(of: music.nowPlaying) { _, _ in presentKaraokeIfNeeded() }
    .onChange(of: music.isPlaying) { _, playing in
      if playing { presentKaraokeIfNeeded() }
    }
    .onChange(of: music.isFollowing) { _, following in
      if following { presentKaraokeIfNeeded() }
    }
    .task {
      if DemoLaunch.autoStart {
        music.startDemo()
        if let seek = DemoLaunch.seek {
          music.seekDemo(to: seek)
        }
        if DemoLaunch.paused {
          music.pauseDemo()
        }
      }
      if let route = DemoLaunch.route {
        path.append(route)
      } else if DemoLaunch.autoStart {
        path.append(Route.karaoke)
      }
    }
  }

  /// `.onChange` does not fire for the value already present, so launch has to
  /// check on appear as well — Music may already be playing when Bar4Bar opens.
  private func presentKaraokeIfNeeded() {
    if PlaybackNavigation.shouldPresentKaraoke(
      for: music.nowPlaying,
      isStartingPlayback: music.isStartingPlayback,
      isAtHub: path.isEmpty,
      isPlaying: music.isPlaying
    ) {
      path.append(Route.karaoke)
    }
  }
}

/// Launch-time demo controls.
///
/// The tvOS simulator gives no way to drive the Siri Remote from a script, so
/// without these the karaoke screen cannot be reached — or screenshotted —
/// automatically. Seeking to a fixed time and pausing also makes captures
/// deterministic, which is what App Store screenshots need.
///
/// Read from the environment rather than compiled in, so this costs the
/// shipping app nothing: with no variables set, `autoStart` is false.
enum DemoLaunch {
  private static var env: [String: String] { ProcessInfo.processInfo.environment }

  /// Deterministic accessibility review without changing simulator preferences.
  static var browseFixture: Bool { env["BAR4BAR_BROWSE_FIXTURE"] == "1" }
  static var reduceMotion: Bool { env["BAR4BAR_REDUCE_MOTION"] == "1" }
  static var autoStart: Bool { env["BAR4BAR_AUTODEMO"] == "1" }
  static var paused: Bool { env["BAR4BAR_DEMO_PAUSED"] == "1" }
  /// Deterministic, control-free stage captures at a paused cue.
  static var cleanStage: Bool { env["BAR4BAR_STAGE_CLEAN"] == "1" }
  static var seek: Double? {
    guard let raw = env["BAR4BAR_DEMO_SEEK"], let v = Double(raw) else { return nil }
    return v
  }

  /// Force a browse state that live data will not reproduce on demand. Results
  /// come from the real catalog now, so this is only `empty`, `loading`, or
  /// `error` — the three states you cannot ask the network for.
  static var fakeResults: String? {
    guard let raw = env["BAR4BAR_FAKE_RESULTS"], !raw.isEmpty else { return nil }
    return raw
  }

  /// Park the Spotify pairing screen on its code state.
  ///
  /// The real state needs a deployment that answers `/api/tv-pair`, and the
  /// simulator cannot reach an http dev server through ATS, so this is the only
  /// way to lay out and capture the screen that matters most on that flow.
  static var fakePairCode: String? {
    guard let raw = env["BAR4BAR_FAKE_PAIR"], !raw.isEmpty else { return nil }
    return raw
  }

  /// Kick off a real pairing attempt on launch, so the live failure paths (no
  /// endpoints deployed, no client id configured) can be reached and read —
  /// they sit behind a button press no script can make.
  static var autoPair: Bool { env["BAR4BAR_AUTOPAIR"] == "1" }

  /// Run a real search on launch. The simulator has no way to type on the Siri
  /// Remote, so without this the populated results grid — the state the search
  /// screen is actually for — cannot be reached or captured at all.
  static var searchTerm: String? {
    guard let raw = env["BAR4BAR_SEARCH"], !raw.isEmpty else { return nil }
    return raw
  }

  /// Jump straight to a screen. Without this, Search and Settings sit behind a
  /// button press that no script can make, so they were the two screens that
  /// went unlooked-at the longest.
  static var route: Route? {
    switch env["BAR4BAR_ROUTE"] {
    case "search": return .search
    case "settings": return .settings
    case "karaoke": return .karaoke
    case "spotify": return .spotify
    default: return nil
    }
  }
}

enum Route: Hashable {
  case search
  case karaoke
  case settings
  case spotify
}

/// Keeps automatic navigation conservative: never interrupt another screen,
/// never double-push for an in-app play request, never treat the demo as
/// externally started playback, and never open over a paused track.
enum PlaybackNavigation {
  static func shouldPresentKaraoke(
    for track: NowPlayingTrack?,
    isStartingPlayback: Bool,
    isAtHub: Bool,
    isPlaying: Bool
  ) -> Bool {
    guard let track, isPlaying else { return false }
    return isAtHub && !isStartingPlayback && !track.isDemo
  }

  /// Pairing is a waiting room. Once Spotify is actually playing a song, the
  /// lyrics screen is the destination — same as Apple Music auto-opening from
  /// the hub.
  static func shouldOpenFollowKaraoke(connected: Bool, hasTrack: Bool, isPlaying: Bool) -> Bool {
    connected && hasTrack && isPlaying
  }
}

enum ChromeIdle {
  /// Lean-back delay. Longer than desktop: a viewer across the room needs it.
  static let seconds: TimeInterval = 4.8
}
