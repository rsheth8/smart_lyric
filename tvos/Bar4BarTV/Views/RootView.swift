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
          }
        }
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

  /// Drive the browse surfaces with placeholder state so every branch of the
  /// search screen can be laid out where MusicKit will not run. One of
  /// `results`, `empty`, `loading`, `error`.
  static var fakeResults: String? {
    guard let raw = env["BAR4BAR_FAKE_RESULTS"], !raw.isEmpty else { return nil }
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
    default: return nil
    }
  }
}

enum Route: Hashable {
  case search
  case karaoke
  case settings
}
