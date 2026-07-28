import Foundation
import Combine
import Bar4BarCore

@MainActor
final class LyricsSession: ObservableObject {
  @Published var timeline: Timeline = Timeline(lines: [])
  @Published var isLoading = false
  @Published var errorMessage: String?
  @Published var statusMessage: String?
  @Published var syncOffset: Double = 0
  @Published var singerLead: Double = DisplayMath.singerLead
  /// Per-song accent, rebuilt from the artwork's hue. Views must read this
  /// rather than the brand gold — see `AccentPalette`.
  @Published var accent: AccentPalette = .brand

  private var client = LyricsClient()
  private let cache = TimelineCache()
  private var offsetsKey = "bar4bar.tv.syncOffsets"

  func configure(apiBase: URL?) {
    client = LyricsClient(apiBaseURL: apiBase)
  }

  func load(for track: NowPlayingTrack) async {
    // The demo ships its timeline in the binary — no fetch, no cache, and it
    // must never be persisted under a cache key a real track could collide with.
    await applyAccent(for: track)

    if track.isDemo {
      timeline = DemoSong.timeline()
      currentCacheKey = nil
      syncOffset = 0
      isLoading = false
      errorMessage = nil
      statusMessage = "Demo · word-level"
      return
    }

    let key = TimelineCache.cacheKey(
      artist: track.artist,
      track: track.title,
      duration: track.duration
    )
    if let cached = cache.load(key: key), !cached.isEmpty {
      timeline = cached
      syncOffset = storedOffset(for: key)
      statusMessage = "Lyrics · \(cached.source ?? "cache")"
      errorMessage = nil
      return
    }

    isLoading = true
    errorMessage = nil
    statusMessage = "Fetching lyrics…"
    defer { isLoading = false }

    let query = LyricsClient.Query(
      artist: track.artist,
      track: track.title,
      duration: track.duration
    )
    guard let result = await client.fetch(query) else {
      timeline = Timeline(lines: [])
      errorMessage = "No synced lyrics found for “\(track.title)”."
      statusMessage = nil
      return
    }
    timeline = result.timeline
    cache.save(result.timeline, key: key)
    syncOffset = storedOffset(for: key)
    statusMessage = "Lyrics · \(result.timeline.source ?? "catalog")"
  }

  /// Drop the loaded song.
  ///
  /// Without this, stopping the demo left its timeline on screen: the app only
  /// reloads lyrics when `nowPlaying` becomes non-nil, so clearing the track
  /// alone left the karaoke ladder scrolling words for a song that was no
  /// longer playing.
  func clear() {
    timeline = Timeline(lines: [])
    currentCacheKey = nil
    syncOffset = 0
    isLoading = false
    errorMessage = nil
    statusMessage = nil
    accent = .brand
  }

  func cueTime(playbackTime: Double) -> Double {
    playbackTime + syncOffset + singerLead
  }

  func nudgeSync(by delta: Double) {
    syncOffset = (syncOffset + delta * 1000).rounded() / 1000
    persistCurrentOffset()
  }

  func resetSync() {
    syncOffset = 0
    persistCurrentOffset()
  }

  func setSingerLead(_ value: Double) {
    singerLead = DisplayMath.clampSingerLead(value)
  }

  // MARK: - Art-adaptive accent

  /// Rebuild `accent` from this track's artwork. Soft-fails to the brand gold —
  /// a cover that won't download or won't yield a usable hue must never leave
  /// the UI without an accent.
  private func applyAccent(for track: NowPlayingTrack) async {
    if let dominant = track.dominantColor {
      accent = AccentPalette.from(dominant: dominant)
      return
    }
    guard let url = track.artworkURL else {
      accent = .brand
      return
    }
    guard let dominant = await ArtworkAccent.dominantColor(of: url) else {
      accent = .brand
      return
    }
    accent = AccentPalette.from(dominant: dominant)
  }

  // MARK: - Per-track offset store

  private var currentCacheKey: String?

  private func storedOffset(for key: String) -> Double {
    currentCacheKey = key
    let map = UserDefaults.standard.dictionary(forKey: offsetsKey) as? [String: Double] ?? [:]
    return map[key] ?? 0
  }

  private func persistCurrentOffset() {
    guard let key = currentCacheKey else { return }
    var map = UserDefaults.standard.dictionary(forKey: offsetsKey) as? [String: Double] ?? [:]
    map[key] = syncOffset
    UserDefaults.standard.set(map, forKey: offsetsKey)
  }
}
