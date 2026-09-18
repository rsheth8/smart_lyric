import SwiftUI
import UIKit

@main
struct Bar4BarTVApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var music = MusicPlayerService()
  @StateObject private var session = LyricsSession()
  @StateObject private var spotify = SpotifyService()
  @StateObject private var listening = TVListeningService()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(music)
        .environmentObject(session)
        .environmentObject(spotify)
        .environmentObject(listening)
        .preferredColorScheme(.dark)
        .onChange(of: music.isPlaying) { _, playing in
          UIApplication.shared.isIdleTimerDisabled = playing && scenePhase == .active
        }
        .onChange(of: scenePhase) { _, phase in
          UIApplication.shared.isIdleTimerDisabled = phase == .active && music.isPlaying
          if phase == .active { music.handleSceneActive() }
        }
        .task {
          listening.configure(session: session, music: music)
          session.configure(apiBase: AppConfig.lyricsAPIBase, officialOnly: AppConfig.officialLyricsOnly)
          async let browse: Void = music.bootstrap()
          if AppConfig.spotifyFollowEnabled {
            music.spotifyRemote = spotify
            spotify.configure(apiBase: AppConfig.lyricsAPIBase)
            async let reconnect: Void = spotify.restore()
            _ = await (browse, reconnect)
          } else {
            await browse
          }
        }
        .task(id: music.nowPlaying?.id) {
          guard let track = music.nowPlaying else { session.clear(); return }
          await session.load(for: track)
        }
        .onChange(of: spotify.track) { _, track in
          guard AppConfig.spotifyFollowEnabled else { return }
          // A background Spotify poll must never replace an explicitly chosen
          // Apple Music song or demo, and it must not fight audio already
          // coming from Music on this TV.
          guard !music.isStartingPlayback, !music.isSystemMusicPlaying else { return }
          guard music.isFollowing || music.nowPlaying == nil else { return }
          guard let track, let clock = spotify.followClock else {
            music.stopFollowing()
            return
          }
          music.beginFollowing(clock, track: track, sourceLabel: "Spotify")
        }
        .onChange(of: spotify.state) { _, state in
          guard AppConfig.spotifyFollowEnabled else { return }
          if state == .disconnected { music.stopFollowing() }
        }
        .onChange(of: spotify.nextUp) { _, item in
          guard AppConfig.spotifyFollowEnabled else { return }
          guard let item else { return }
          guard music.isFollowing || music.nowPlaying == nil else { return }
          session.prepareNext(.upcoming(item), skipIf: music.nowPlaying)
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

  /// Spotify follow remains available in development while product access and
  /// synchronized-display rights are resolved. Release builds default it off,
  /// which prevents a dormant integration from initiating network traffic or
  /// appearing as a public promise.
  static var spotifyFollowEnabled: Bool {
    enabled(Bundle.main.object(forInfoDictionaryKey: "SPOTIFY_FOLLOW_ENABLED"))
  }

  /// Distribution must never fall back to scraped or community lyric bodies.
  /// Reviewed prepared timelines and responses explicitly marked licensed are
  /// the only catalog sources accepted by a Release build.
  static var officialLyricsOnly: Bool {
    enabled(Bundle.main.object(forInfoDictionaryKey: "OFFICIAL_LYRICS_ONLY"))
  }

  static func enabled(_ value: Any?) -> Bool {
    switch value {
    case let value as Bool: return value
    case let value as NSNumber: return value.boolValue
    case let value as String:
      return ["1", "true", "yes"].contains(value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    default: return false
    }
  }
}
