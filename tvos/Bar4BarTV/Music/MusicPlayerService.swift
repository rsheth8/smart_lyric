import Foundation
import MusicKit
import Combine
import Bar4BarCore

/// Now-playing metadata fed to the lyric pipeline.
struct NowPlayingTrack: Equatable, Identifiable {
  var id: String
  var title: String
  var artist: String
  var album: String
  var duration: TimeInterval?
  var artworkURL: URL?
  /// True for the bundled demo track — the one case with no MusicKit behind it.
  var isDemo: Bool = false
  /// Dominant artwork color, when we know it without downloading the image.
  var dominantColor: RGB?
}

extension CatalogItem {
  init(_ song: Song) {
    // 2× the layout size: a 260pt poster on a 4K panel is 520 real pixels, and
    // MusicKit will happily hand back a soft thumbnail otherwise.
    let px = Int(Tokens.cardW) * 2
    self.init(
      id: song.id.rawValue,
      title: song.title,
      artist: song.artistName,
      album: song.albumTitle,
      artworkURL: song.artwork?.url(width: px, height: px),
      duration: song.duration
    )
  }
}

@MainActor
final class MusicPlayerService: ObservableObject {
  @Published var authStatus: MusicAuthorization.Status = .notDetermined
  @Published var isPlaying = false
  @Published var playbackTime: TimeInterval = 0
  @Published var nowPlaying: NowPlayingTrack?
  @Published var statusMessage: String?
  @Published var errorMessage: String?

  // MARK: Browse state
  //
  // None of this needs MusicKit. The hub and the search grid are fed by the
  // public iTunes feeds in `CatalogClient`, which is why they now render in the
  // simulator, and why someone with no Apple Music subscription still sees a
  // full app rather than an empty one.

  @Published var chartSongs: [CatalogItem] = []
  @Published var isLoadingCharts = false
  @Published var searchResults: [CatalogItem] = []
  @Published var isSearching = false
  /// The term behind `searchResults`. Nil means "no search has run yet", which
  /// is a different screen state from "a search ran and found nothing".
  @Published var lastSearchTerm: String?
  @Published var recentSongs: [CatalogItem] = []

  /// Set when someone picks a song we cannot play yet because Apple Music is
  /// not connected. The root presents it as a prompt and plays the song once
  /// authorization comes back — otherwise the press would do nothing at all,
  /// which is the dead end this replaces.
  @Published var connectPrompt: CatalogItem?

  private let player = ApplicationMusicPlayer.shared
  private let catalogClient = CatalogClient()
  private var tickTask: Task<Void, Never>?
  private var searchTask: Task<Void, Never>?
  /// Resolved `Song`s keyed by catalog id, so pressing the same card twice does
  /// not pay for the lookup twice.
  private var resolved: [String: Song] = [:]

  private static let recentsKey = "bar4bar.recents.v1"

  /// Non-nil while the bundled demo is driving the playhead instead of MusicKit.
  private(set) var demoClock: DemoClock?
  var isDemo: Bool { demoClock != nil }

  /// The playhead, read live — call this once per frame from the display.
  ///
  /// `playbackTime` is a `@Published` *snapshot* refreshed by the 20 Hz poll
  /// loop. Driving the word wipe from it meant the karaoke view redrew at 60 fps
  /// while the number underneath it only moved 20 times a second: the highlight
  /// advanced in visible steps, and two out of every three frames rendered
  /// identical content.
  ///
  /// Every source underneath is already continuous — `DemoClock` and
  /// `StreamingClock` interpolate from an anchor, and MusicKit's `playbackTime`
  /// is a live property — so the steppiness was purely the snapshot in the
  /// middle. This restores the seam the design assumes: the display reads one
  /// number per frame and never touches audio.
  ///
  /// `playbackTime` stays published for chrome that genuinely wants throttling
  /// (the elapsed label, section lookups) — those need not run at 60 fps.
  var liveTime: TimeInterval {
    if let demoClock { return demoClock.now() }
    if let followClock { return followClock.now() }
    return player.playbackTime
  }

  /// Non-nil while an external source (Spotify follow) owns the playhead.
  ///
  /// Same seam as the demo: the display reads one number per frame and does not
  /// care who produced it, so following a phone's Spotify playback costs the
  /// karaoke screen exactly nothing.
  private(set) var followClock: StreamingClock?
  var isFollowing: Bool { followClock != nil }

  /// Hand the playhead to an external source.
  func beginFollowing(_ clock: StreamingClock, track: CatalogItem, sourceLabel: String) {
    demoClock = nil
    followClock = clock
    let id = "follow:\(track.title.lowercased())|\(track.artist.lowercased())"
    if nowPlaying?.id != id {
      nowPlaying = NowPlayingTrack(
        id: id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? "",
        duration: track.duration,
        artworkURL: track.artworkURL
      )
    }
    statusMessage = sourceLabel
    startTicking()
  }

  func stopFollowing() {
    guard followClock != nil else { return }
    followClock = nil
    isPlaying = false
    playbackTime = 0
    nowPlaying = nil
    statusMessage = nil
    tickTask?.cancel()
    tickTask = nil
    if authStatus == .authorized { startTicking() }
  }

  func bootstrap() async {
    authStatus = MusicAuthorization.currentStatus
    loadRecents()
    if authStatus == .authorized {
      startTicking()
    }
    await loadCharts()
  }

  // MARK: - Browse

  func loadCharts() async {
    guard chartSongs.isEmpty else { return }
    isLoadingCharts = true
    defer { isLoadingCharts = false }
    chartSongs = await catalogClient.charts(limit: 12)
  }

  /// Debounced search. The Siri Remote keyboard emits a character at a time, so
  /// searching on every keystroke would fire a dozen requests for one word and
  /// let an early, shorter term's response land last.
  func searchDebounced(_ term: String, delay: Duration = .milliseconds(350)) {
    searchTask?.cancel()
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard q.count >= 2 else {
      searchResults = []
      lastSearchTerm = nil
      isSearching = false
      return
    }
    isSearching = true
    searchTask = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled else { return }
      await self?.search(q)
    }
  }

  func search(_ term: String) async {
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else {
      searchResults = []
      lastSearchTerm = nil
      isSearching = false
      return
    }
    isSearching = true
    errorMessage = nil
    let hits = await catalogClient.search(q)
    guard !Task.isCancelled else { return }
    searchResults = hits
    lastSearchTerm = q
    isSearching = false
  }

  // MARK: - Demo playback

  /// Start the bundled demo track. Satisfies the same published contract as the
  /// MusicKit path, so every view downstream is unchanged.
  func startDemo() {
    let clock = DemoClock(duration: DemoSong.duration, loops: true)
    demoClock = clock
    followClock = nil
    nowPlaying = NowPlayingTrack(
      id: "demo",
      title: DemoSong.title,
      artist: DemoSong.artist,
      album: DemoSong.album,
      duration: DemoSong.duration,
      artworkURL: nil,
      isDemo: true,
      dominantColor: DemoSong.artworkDominant
    )
    errorMessage = nil
    statusMessage = nil
    clock.play()
    isPlaying = true
    playbackTime = 0
    startTicking()
  }

  func stopDemo() {
    demoClock?.pause()
    demoClock = nil
    isPlaying = false
    playbackTime = 0
    nowPlaying = nil
    tickTask?.cancel()
    tickTask = nil
    // The demo borrowed the ticker; hand it back rather than leaving a
    // connected account with a dead playhead.
    if authStatus == .authorized { startTicking() }
  }

  func restartDemo() {
    demoClock?.restart()
  }

  func seekDemo(to songTime: Double) {
    demoClock?.seek(to: songTime)
    if let demoClock { playbackTime = demoClock.now() }
  }

  func pauseDemo() {
    demoClock?.pause()
    isPlaying = false
  }

  // MARK: - Authorization

  func requestAccess() async {
    let status = await MusicAuthorization.request()
    authStatus = status
    if status == .authorized {
      statusMessage = "Apple Music connected."
      errorMessage = nil
      startTicking()
    } else {
      errorMessage = "Apple Music access was not granted. Enable it in Settings."
    }
  }

  /// Answer the connect prompt: authorize, then play what they originally
  /// pressed. Returns true when playback actually started, so the caller knows
  /// whether to navigate.
  @discardableResult
  func connectAndPlayPrompted() async -> Bool {
    guard let item = connectPrompt else { return false }
    connectPrompt = nil
    await requestAccess()
    guard authStatus == .authorized else { return false }
    return await play(item)
  }

  // MARK: - Playback

  /// Play a browsed item.
  ///
  /// Browse is public and playback is not, so this is the seam where MusicKit
  /// finally enters. The chart feed and the search API both carry the Apple
  /// Music catalog id, so the common path is an exact id lookup; the title
  /// match is only there for items that arrived from somewhere else.
  ///
  /// Returns false when nothing started, so callers do not push a karaoke screen
  /// over silence.
  @discardableResult
  func play(_ item: CatalogItem) async -> Bool {
    guard authStatus == .authorized else {
      connectPrompt = item
      return false
    }

    guard let song = await resolve(item) else {
      errorMessage = "“\(item.title)” isn’t available on Apple Music in your region."
      return false
    }

    // Playing here always wins: it is the most explicit thing the viewer can do.
    demoClock = nil
    followClock = nil
    do {
      player.queue = [song]
      try await player.play()
      isPlaying = true
      updateNowPlaying(from: song)
      remember(CatalogItem(song))
      errorMessage = nil
      startTicking()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  private func resolve(_ item: CatalogItem) async -> Song? {
    if let cached = resolved[item.id] { return cached }

    // Exact id first — the id we browsed with *is* the Apple Music catalog id.
    if !item.id.isEmpty {
      let request = MusicCatalogResourceRequest<Song>(
        matching: \.id, equalTo: MusicItemID(item.id)
      )
      if let song = try? await request.response().items.first {
        resolved[item.id] = song
        return song
      }
    }

    // Fallback for items with no catalog id, or an id the storefront rejects
    // (region-locked releases hit this). Pick the closest title among the hits
    // rather than the first, which is often a cover or a live version.
    var search = MusicCatalogSearchRequest(term: "\(item.title) \(item.artist)", types: [Song.self])
    search.limit = 10
    guard let songs = try? await search.response().songs, !songs.isEmpty else { return nil }
    let best = songs.max { a, b in
      TitleMatch.titleScore(query: item.title, candidate: a.title)
        < TitleMatch.titleScore(query: item.title, candidate: b.title)
    }
    if let best, TitleMatch.titleScore(query: item.title, candidate: best.title) >= 0.5 {
      resolved[item.id] = best
      return best
    }
    return nil
  }

  func togglePlayPause() async {
    if let demoClock {
      demoClock.toggle()
      isPlaying = demoClock.isPlaying()
      return
    }
    do {
      if player.state.playbackStatus == .playing {
        player.pause()
        isPlaying = false
      } else {
        try await player.play()
        isPlaying = true
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func skipNext() async {
    do { try await player.skipToNextEntry() }
    catch { errorMessage = error.localizedDescription }
  }

  func skipPrevious() async {
    do { try await player.skipToPreviousEntry() }
    catch { errorMessage = error.localizedDescription }
  }

  // MARK: - Internals

  private func startTicking() {
    tickTask?.cancel()
    tickTask = Task { [weak self] in
      while !Task.isCancelled {
        self?.pollPlayer()
        try? await Task.sleep(nanoseconds: 50_000_000) // 20 Hz
      }
    }
  }

  private func pollPlayer() {
    // The demo owns the playhead outright — never let MusicKit's idle state
    // (stopped, position 0) overwrite it.
    if let demoClock {
      isPlaying = demoClock.isPlaying()
      playbackTime = demoClock.now()
      return
    }

    // Following owns the playhead for the same reason the demo does: MusicKit's
    // idle state (stopped, position 0) would otherwise overwrite it every tick.
    if let followClock {
      isPlaying = followClock.isPlaying()
      playbackTime = followClock.now()
      return
    }

    isPlaying = player.state.playbackStatus == .playing
    playbackTime = player.playbackTime

    if let item = player.queue.currentEntry?.item {
      switch item {
      case .song(let song):
        if nowPlaying?.id != song.id.rawValue {
          updateNowPlaying(from: song)
        }
      default:
        break
      }
    }
  }

  private func updateNowPlaying(from song: Song) {
    nowPlaying = NowPlayingTrack(
      id: song.id.rawValue,
      title: song.title,
      artist: song.artistName,
      album: song.albumTitle ?? "",
      duration: song.duration,
      artworkURL: song.artwork?.url(width: 600, height: 600)
    )
  }

  // MARK: - Recents

  /// "Continue" has to survive a relaunch or it is not a continue shelf — the
  /// Apple TV is a device people turn off between sessions, not one they leave
  /// a process running on.
  private func remember(_ item: CatalogItem) {
    recentSongs.removeAll { $0.id == item.id }
    recentSongs.insert(item, at: 0)
    if recentSongs.count > 12 {
      recentSongs = Array(recentSongs.prefix(12))
    }
    if let data = try? JSONEncoder().encode(recentSongs) {
      UserDefaults.standard.set(data, forKey: Self.recentsKey)
    }
  }

  private func loadRecents() {
    guard let data = UserDefaults.standard.data(forKey: Self.recentsKey),
          let items = try? JSONDecoder().decode([CatalogItem].self, from: data)
    else { return }
    recentSongs = items
  }

  // MARK: - Layout harness

  /// Force a browse state that real data will not reproduce on demand.
  ///
  /// Results no longer need faking — `CatalogClient` returns real songs with
  /// real artwork in the simulator — but "empty", "loading", and "error" are
  /// still states worth being able to park on and screenshot. Behind
  /// `BAR4BAR_FAKE_RESULTS`; nothing calls it in a shipping launch.
  func forceBrowseState(_ mode: String, term: String) {
    searchTask?.cancel()
    switch mode {
    case "empty":
      searchResults = []; lastSearchTerm = term; isSearching = false; errorMessage = nil
    case "loading":
      searchResults = []; lastSearchTerm = nil; isSearching = true; errorMessage = nil
    case "error":
      searchResults = []; lastSearchTerm = term; isSearching = false
      errorMessage = "The Internet connection appears to be offline."
    default:
      Task { await search(term) }
    }
  }
}
