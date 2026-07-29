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
            SpotifyPairingView(path: $path)
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
          if await music.connectAndPlayPrompted() {
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
    .onChange(of: music.nowPlaying) { _, track in
      // The demo and the song cards push karaoke themselves; this only catches
      // playback that started from outside the app (Siri, Control Center).
      guard let track, !track.isDemo else { return }
      guard !session.timeline.isEmpty || session.isLoading else { return }
      if path.isEmpty {
        path.append(Route.karaoke)
      }
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

  static var autoStart: Bool { env["BAR4BAR_AUTODEMO"] == "1" }
  static var paused: Bool { env["BAR4BAR_DEMO_PAUSED"] == "1" }
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
