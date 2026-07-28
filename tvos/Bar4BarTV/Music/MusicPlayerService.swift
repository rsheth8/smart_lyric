import Foundation
import MusicKit
import Combine
import Bar4BarCore

/// A song as the UI needs it.
///
/// The views used to take `MusicKit.Song` directly, which quietly made every
/// browse surface untestable: `Song` has no public initializer, so the results
/// grid and the hub shelves could not be rendered anywhere MusicKit refuses to
/// run — which is to say, in the simulator, which is everywhere we can actually
/// look at them. Resolving the artwork URL once at the right size also stops
/// each card from asking for its own.
struct SongItem: Identifiable, Equatable, Hashable {
  let id: String
  let title: String
  let artist: String
  let artworkURL: URL?

  init(id: String, title: String, artist: String, artworkURL: URL?) {
    self.id = id
    self.title = title
    self.artist = artist
    self.artworkURL = artworkURL
  }

  init(_ song: Song) {
    // 2× the layout size: a 260pt poster on a 4K panel is 520 real pixels, and
    // MusicKit will happily hand back a soft thumbnail otherwise.
    let px = Int(Tokens.cardW) * 2
    self.init(
      id: song.id.rawValue,
      title: song.title,
      artist: song.artistName,
      artworkURL: song.artwork?.url(width: px, height: px)
    )
  }
}

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

@MainActor
final class MusicPlayerService: ObservableObject {
  @Published var authStatus: MusicAuthorization.Status = .notDetermined
  @Published var isPlaying = false
  @Published var playbackTime: TimeInterval = 0
  @Published var nowPlaying: NowPlayingTrack?
  @Published var searchResults: [SongItem] = []
  @Published var recentSongs: [SongItem] = []
  @Published var statusMessage: String?
  @Published var errorMessage: String?
  @Published var isSearching = false
  /// The term behind `searchResults`. Nil means "no search has run yet", which
  /// is a different screen state from "a search ran and found nothing".
  @Published var lastSearchTerm: String?

  private let player = ApplicationMusicPlayer.shared
  private var tickTask: Task<Void, Never>?
  /// Playable `Song`s behind the `SongItem`s the UI holds, keyed by catalog id.
  private var catalog: [String: Song] = [:]

  /// Non-nil while the bundled demo is driving the playhead instead of MusicKit.
  private(set) var demoClock: DemoClock?
  var isDemo: Bool { demoClock != nil }

  func bootstrap() async {
    authStatus = MusicAuthorization.currentStatus
    if authStatus == .authorized {
      startTicking()
    }
  }

  // MARK: - Demo playback

  /// Start the bundled demo track. Satisfies the same published contract as the
  /// MusicKit path, so every view downstream is unchanged.
  func startDemo() {
    let clock = DemoClock(duration: DemoSong.duration, loops: true)
    demoClock = clock
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

  func search(_ term: String) async {
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else {
      searchResults = []
      lastSearchTerm = nil
      return
    }
    isSearching = true
    errorMessage = nil
    defer { isSearching = false }
    do {
      var request = MusicCatalogSearchRequest(term: q, types: [Song.self])
      request.limit = 24
      let response = try await request.response()
      for song in response.songs { catalog[song.id.rawValue] = song }
      searchResults = response.songs.map(SongItem.init)
      lastSearchTerm = q
    } catch {
      // A failed search must not leave the previous term's results on screen
      // looking like an answer to the new one.
      searchResults = []
      lastSearchTerm = q
      errorMessage = error.localizedDescription
    }
  }

  func play(_ item: SongItem) async {
    guard let song = catalog[item.id] else {
      errorMessage = "“\(item.title)” is no longer available to play."
      return
    }
    // A real track always wins over the demo.
    demoClock = nil
    do {
      player.queue = [song]
      try await player.play()
      isPlaying = true
      updateNowPlaying(from: song)
      remember(item)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
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

    isPlaying = player.state.playbackStatus == .playing
    playbackTime = player.playbackTime

    if let item = player.queue.currentEntry?.item {
      switch item {
      case .song(let song):
        let track = NowPlayingTrack(
          id: song.id.rawValue,
          title: song.title,
          artist: song.artistName,
          album: song.albumTitle ?? "",
          duration: song.duration,
          artworkURL: song.artwork?.url(width: 400, height: 400)
        )
        if nowPlaying?.id != track.id {
          nowPlaying = track
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
      artworkURL: song.artwork?.url(width: 400, height: 400)
    )
  }

  private func remember(_ item: SongItem) {
    recentSongs.removeAll { $0.id == item.id }
    recentSongs.insert(item, at: 0)
    if recentSongs.count > 12 {
      recentSongs = Array(recentSongs.prefix(12))
    }
  }

  // MARK: - Layout harness

  /// Fill the browse surfaces with placeholder rows so the grid and shelves can
  /// be laid out and looked at. MusicKit refuses to run in the simulator, so
  /// without this the results grid is unreachable on every machine that can
  /// actually render it. Behind `BAR4BAR_FAKE_RESULTS`; nothing calls it in a
  /// shipping launch, and the rows are unplayable by construction — they are
  /// not in `catalog`, so selecting one takes the "no longer available" path.
  func loadPlaceholderResults(term: String, mode: String = "results") {
    switch mode {
    case "empty":
      searchResults = []
      lastSearchTerm = term
      isSearching = false
      errorMessage = nil
      return
    case "loading":
      searchResults = []
      isSearching = true
      errorMessage = nil
      return
    case "error":
      searchResults = []
      lastSearchTerm = term
      isSearching = false
      errorMessage = "The Internet connection appears to be offline."
      return
    default:
      break
    }

    let titles = [
      ("Midnight Ledger", "Cassidy Vale"), ("Paper Rooftops", "The Long Way Home"),
      ("Ninety-Nine Bars", "Oke & Sunday"), ("Slow Gold", "Marisol Reyes"),
      ("Every Word Right", "Bar4Bar"), ("Held Note", "Ivory Season"),
      ("Count It In", "The Downbeats"), ("Room Turns Gold", "Cassidy Vale"),
      ("Second Vocalist", "Duet Practice"), ("Up-Beat Now", "Quicksilver"),
    ]
    searchResults = titles.enumerated().map { index, pair in
      SongItem(id: "placeholder-\(index)", title: pair.0, artist: pair.1, artworkURL: nil)
    }
    recentSongs = Array(searchResults.prefix(6))
    lastSearchTerm = term
    isSearching = false
    errorMessage = nil
  }
}
