import SwiftUI

@main
struct Bar4BarTVApp: App {
  @StateObject private var music = MusicPlayerService()
  @StateObject private var session = LyricsSession()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(music)
        .environmentObject(session)
        .preferredColorScheme(.dark)
        .task {
          session.configure(apiBase: AppConfig.lyricsAPIBase)
          await music.bootstrap()
        }
        .onChange(of: music.nowPlaying) { _, track in
          guard let track else { return }
          Task { await session.load(for: track) }
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
          let url = URL(string: raw)
    else { return nil }
    return url
  }
}
