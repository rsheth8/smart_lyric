import SwiftUI

@main
struct Bar4BarTVApp: App {
  @StateObject private var music = MusicPlayerService()
  @StateObject private var session = LyricsSession()
  @StateObject private var spotify = SpotifyService()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(music)
        .environmentObject(session)
        .environmentObject(spotify)
        .preferredColorScheme(.dark)
        .task {
          session.configure(apiBase: AppConfig.lyricsAPIBase)
          spotify.configure(apiBase: AppConfig.lyricsAPIBase)
          await music.bootstrap()
          // Reconnects silently when a refresh token survived; does nothing at
          // all otherwise, so an unpaired install pays no launch cost.
          await spotify.restore()
        }
        .onChange(of: music.nowPlaying) { _, track in
          guard let track else { return }
          Task { await session.load(for: track) }
        }
        // The bridge between following and the display. Spotify owns "what is
        // playing"; `MusicPlayerService` owns "what is on screen", and this is
        // the one line that connects them — everything downstream is unchanged
        // because it only ever reads a clock.
        .onChange(of: spotify.track) { _, track in
          guard let track, let clock = spotify.followClock else { return }
          music.beginFollowing(clock, track: track, sourceLabel: "Following Spotify")
        }
    }
  }
}

enum AppConfig {
  /// Set `LYRICS_API_BASE` in the target build settings / Info.plist to your
  /// Vercel origin (e.g. `https://your-app.vercel.app`). Empty → LRCLIB only.
  static var lyricsAPIBase: URL? {
    let raw = (Bundle.main.object(forInfoDictionaryKey: "LYRICS_API_BASE") as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !raw.isEmpty,
          raw != "https://localhost",
          let url = URL(string: raw),
          // A host is what makes this a usable base. Requiring one catches the
          // xcconfig "//" comment trap, which truncates the value to "https:" —
          // a string that parses as a URL, produces no error anywhere, and
          // quietly disables every proxy that depends on it.
          let host = url.host, !host.isEmpty
    else { return nil }
    return url
  }
}
