import Foundation
import Combine
import Bar4BarCore

@MainActor
final class LyricsSession: ObservableObject {
  @Published var timeline: Timeline = Timeline(lines: []) {
    // A `didSet` rather than a call at each assignment site: the timeline is set
    // from five places (demo, cache hit, fetch, fetch-failure, clear) and a
    // rail left over from the previous song is worse than no rail at all.
    didSet {
      guard timeline != oldValue else { return }
      sections = Sections.derive(timeline)
    }
  }
  @Published var isLoading = false
  @Published var errorMessage: String?
  @Published var statusMessage: String?
  @Published var syncOffset: Double = 0
  @Published var singerLead: Double = DisplayMath.singerLead
  /// Per-song accent, rebuilt from the artwork's hue. Views must read this
  /// rather than the brand gold — see `AccentPalette`.
  @Published var accent: AccentPalette = .brand

  /// Derived song structure for the rail. Recomputed once per timeline rather
  /// than per frame — `derive` walks every line and every word.
  @Published private(set) var sections: [Sections.Section] = []

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

  // MARK: - Structure

  /// Called from a view body, so it stays a pure read — `Sections.index` takes
  /// a hint for callers that track one, but a song has a dozen sections at most
  /// and the unhinted scan is not worth caching state for.
  func sectionIndex(at playbackTime: Double) -> Int? {
    Sections.index(in: sections, at: cueTime(playbackTime: playbackTime))
  }

  func sectionLabel(at playbackTime: Double) -> String? {
    guard let idx = sectionIndex(at: playbackTime) else { return nil }
    return sections[idx].part.rawValue
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
