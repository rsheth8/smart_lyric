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
  var recording: RecordingIdentity?

  static func upcoming(_ item: CatalogItem) -> NowPlayingTrack {
    let id = item.recording?.spotifyID.map { "follow:\($0)" }
      ?? (item.id.isEmpty ? "upcoming:\(item.title)" : item.id)
    return NowPlayingTrack(
      id: id,
      title: item.title,
      artist: item.artist,
      album: item.album ?? "",
      duration: item.duration,
      artworkURL: item.artworkURL,
      recording: item.recording
    )
  }
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
      duration: song.duration,
      recording: RecordingIdentity(appleMusicID: song.id.rawValue, isrc: song.isrc)
    )
  }
}

@MainActor
final class MusicPlayerService: ObservableObject {
  @Published var authStatus: MusicAuthorization.Status = .notDetermined
  @Published var isPlaying = false
  @Published private(set) var isStartingPlayback = false
  @Published private(set) var isConnecting = false
  private var playbackRequestID = UUID()
  @Published var playbackTime: TimeInterval = 0
  @Published var nowPlaying: NowPlayingTrack?
  @Published var statusMessage: String?
  @Published var errorMessage: String?
  @Published private(set) var isLoved = false
  @Published private(set) var isInLibrary = false
  @Published private(set) var isLoving = false
  @Published private(set) var isAddingToLibrary = false
  @Published private(set) var shuffleEnabled = false
  @Published private(set) var repeatCycle: RepeatCycle = .off
  /// Short confirmation for Love / Library — not `errorMessage`, which alerts.
  @Published private(set) var actionHint: String?

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
  @Published var searchError: String?
  private var searchID = UUID()
  /// The term behind `searchResults`. Nil means "no search has run yet", which
  /// is a different screen state from "a search ran and found nothing".
  @Published var lastSearchTerm: String?
  @Published var recentSongs: [CatalogItem] = []

  /// Set when someone picks a song we cannot play yet because Apple Music is
  /// not connected. The root presents it as a prompt and plays the song once
  /// authorization comes back — otherwise the press would do nothing at all,
  /// which is the dead end this replaces.
  @Published var connectPrompt: CatalogItem?

  // MARK: - Search scope

  enum SearchScope { case songs, albums }
  @Published var albumResults: [CatalogItem] = []

  /// The Music app's player — not `ApplicationMusicPlayer`, which is a private
  /// queue that never sees Siri, Control Center, or Music itself.
  private let player = SystemMusicPlayer.shared
  private let catalogClient = CatalogClient()
  private var tickTask: Task<Void, Never>?
  private var searchTask: Task<Void, Never>?
  private var playerCancellables = Set<AnyCancellable>()
  /// Resolved `Song`s keyed by catalog id, so pressing the same card twice does
  /// not pay for the lookup twice.
  private var resolved: [String: Song] = [:]
  private var currentSong: Song?
  private var socialTask: Task<Void, Never>?
  private var hintTask: Task<Void, Never>?

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
    if !isSystemMusicPlaying {
      if let demoClock { return demoClock.now() }
      if let followClock { return followClock.now() }
    }
    return player.playbackTime
  }

  /// True when this Apple TV is actually playing Apple Music — that audio wins
  /// over the bundled demo and over Spotify follow.
  var isSystemMusicPlaying: Bool {
    guard authStatus == .authorized else { return false }
    return player.state.playbackStatus == .playing && player.queue.currentEntry != nil
  }

  /// Non-nil while an external source (Spotify follow) owns the playhead.
  ///
  /// Same seam as the demo: the display reads one number per frame and does not
  /// care who produced it, so following a phone's Spotify playback costs the
  /// karaoke screen exactly nothing.
  private(set) var followClock: StreamingClock?
  var isFollowing: Bool { followClock != nil }

  /// Transport (pause / skip / seek) works for Apple Music, the demo, and
  /// Spotify follow — follow commands the account's active Spotify device.
  var canTransport: Bool { nowPlaying != nil }
  /// Next track is available on Apple Music and Spotify, not the bundled demo.
  var canSkipTracks: Bool { canTransport && !isDemo }
  /// Love, library, shuffle, and repeat need Apple Music on this TV.
  var canControlQueue: Bool { canTransport && !isDemo && !isFollowing }
  var canLove: Bool { canControlQueue && catalogSongID != nil }
  var canAddToLibrary: Bool { canControlQueue && currentSong != nil }

  weak var spotifyRemote: (any SpotifyRemoteControlling)?

  private var catalogSongID: String? {
    guard canControlQueue else { return nil }
    if let id = nowPlaying?.recording?.appleMusicID, !id.isEmpty { return id }
    if let id = nowPlaying?.id, !id.isEmpty, id.allSatisfy(\.isNumber) { return id }
    return currentSong?.id.rawValue
  }

  /// Hand the playhead to an external source.
  func beginFollowing(_ clock: StreamingClock, track: CatalogItem, sourceLabel: String) {
    playbackRequestID = UUID()
    isStartingPlayback = false
    if authStatus == .authorized { player.pause() }
    demoClock = nil
    followClock = clock
    currentSong = nil
    clearSocial()
    let stable = track.recording?.spotifyID?.trimmingCharacters(in: .whitespacesAndNewlines)
    let id = "follow:" + ((stable?.isEmpty == false ? stable! : nil)
      ?? TimelineCache.cacheKey(artist: track.artist, track: track.title,
        duration: track.duration, album: track.album, recording: track.recording))
    let next = NowPlayingTrack(
      id: id,
      title: track.title,
      artist: track.artist,
      album: track.album ?? "",
      duration: track.duration,
      artworkURL: track.artworkURL,
      recording: track.recording
    )
    if nowPlaying?.id == id {
      if nowPlaying != next { nowPlaying = next }
    } else {
      nowPlaying = next
    }
    statusMessage = sourceLabel
    errorMessage = nil
    isPlaying = clock.isPlaying()
    playbackTime = clock.now()
    startTicking()
  }

  func stopFollowing() {
    guard followClock != nil else { return }
    followClock = nil
    isPlaying = false
    playbackTime = 0
    nowPlaying = nil
    statusMessage = nil
    if authStatus == .authorized {
      startTicking()
      pollPlayer()
    } else {
      tickTask?.cancel()
      tickTask = nil
    }
  }

  func refreshAuthorization() {
    authStatus = MusicAuthorization.currentStatus
  }

  /// Returning from Settings (or Music) is when authorization and the system
  /// queue can change without this process restarting.
  func handleSceneActive() {
    refreshAuthorization()
    guard authStatus == .authorized else { return }
    Task { await attachSystemPlayer() }
  }

  func bootstrap() async {
    refreshAuthorization()
    loadRecents()
    if authStatus == .authorized {
      await attachSystemPlayer()
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
  func searchDebounced(_ term: String, scope: SearchScope = .songs, delay: Duration = .milliseconds(350)) {
    searchTask?.cancel()
    searchID = UUID()
    searchError = nil
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard q.count >= 2 else {
      searchResults = []
      albumResults = []
      lastSearchTerm = nil
      isSearching = false
      return
    }
    isSearching = true
    searchTask = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled else { return }
      if scope == .albums {
        await self?.searchAlbums(q)
      } else {
        await self?.search(q)
      }
    }
  }

  func searchAlbums(_ term: String) async {
    let id = UUID()
    searchID = id
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else {
      albumResults = []
      lastSearchTerm = nil
      isSearching = false
      return
    }
    isSearching = true
    searchError = nil
    let hits = await catalogClient.searchAlbums(q)
    guard !Task.isCancelled, searchID == id else { return }
    albumResults = hits
    lastSearchTerm = q
    isSearching = false
  }

  func search(_ term: String) async {
    let id = UUID()
    searchID = id
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else {
      searchResults = []
      lastSearchTerm = nil
      isSearching = false
      return
    }
    isSearching = true
    searchError = nil
    do {
      let hits = try await catalogClient.searchResults(q)
      guard !Task.isCancelled, searchID == id else { return }
      searchResults = hits
    } catch {
      guard !Task.isCancelled, searchID == id else { return }
      searchResults = []
      searchError = "Check your internet connection and try searching again."
    }
    lastSearchTerm = q
    isSearching = false
  }

  // MARK: - Demo playback

  /// Start the bundled demo track. Satisfies the same published contract as the
  /// MusicKit path, so every view downstream is unchanged.
  func startDemo() {
    playbackRequestID = UUID()
    isStartingPlayback = false
    if authStatus == .authorized { player.pause() }
    let clock = DemoClock(duration: DemoSong.duration, loops: true)
    demoClock = clock
    followClock = nil
    currentSong = nil
    clearSocial()
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
  }

  func restartDemo() {
    demoClock?.restart()
  }

  func seekDemo(to songTime: Double) {
    stageSeekRevision += 1
    demoClock?.seek(to: songTime)
    if let demoClock { playbackTime = demoClock.now() }
  }

  func pauseDemo() {
    demoClock?.pause()
    isPlaying = false
  }

  // MARK: - Authorization

  func requestAccess() async {
    guard !isConnecting else { return }
    #if targetEnvironment(simulator)
    errorMessage = AppConfig.spotifyFollowEnabled
      ? "Apple Music playback needs a real Apple TV. You can explore the demo or follow Spotify here."
      : "Apple Music playback needs a real Apple TV. You can still explore the demo here."
    return
    #else
    isConnecting = true
    defer { isConnecting = false }
    let status = await MusicAuthorization.request()
    authStatus = status
    if status == .authorized {
      statusMessage = "Apple Music connected."
      errorMessage = nil
      await attachSystemPlayer()
    } else {
      errorMessage = "Allow Bar4Bar to access Apple Music in Apple TV Settings, then try again."
    }
    #endif
  }

  /// Answer the connect prompt: authorize, then play what they originally
  /// pressed. Returns true when playback actually started, so the caller knows
  /// whether to navigate.
  @discardableResult
  func connectAndPlayPrompted(_ item: CatalogItem) async -> Bool {
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
    guard !isStartingPlayback else { return false }
    authStatus = MusicAuthorization.currentStatus
    guard authStatus == .authorized else {
      connectPrompt = item
      return false
    }

    let requestID = UUID()
    playbackRequestID = requestID
    isStartingPlayback = true
    errorMessage = nil
    defer { if playbackRequestID == requestID { isStartingPlayback = false } }
    do {
      let subscription = try await MusicSubscription.current
      guard playbackRequestID == requestID else { return false }
      guard subscription.canPlayCatalogContent else {
        errorMessage = "An Apple Music subscription is needed. Open Music on this Apple TV and check the signed-in account."
        return false
      }
    } catch {
      guard playbackRequestID == requestID else { return false }
      errorMessage = "Couldn’t check Apple Music. Open Music on this Apple TV, check your account and connection, then try again."
      return false
    }
    let resolvedSong = await resolve(item)
    guard playbackRequestID == requestID, !Task.isCancelled else { return false }
    guard let song = resolvedSong else {
      errorMessage = "“\(item.title)” isn’t available on Apple Music in your region."
      return false
    }

    // Playing here always wins: it is the most explicit thing the viewer can do.
    do {
      player.queue = [song]
      try await player.play()
      guard playbackRequestID == requestID else { return false }
      demoClock?.pause()
      demoClock = nil
      followClock = nil
      statusMessage = "Apple Music"
      isPlaying = true
      applyNowPlaying(track(from: song))
      errorMessage = nil
      startObservingPlayer()
      startTicking()
      return true
    } catch {
      guard playbackRequestID == requestID else { return false }
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
    let eligible = songs.filter {
      TitleMatch.titleScore(query: TitleMatch.primaryArtist(item.artist), candidate: TitleMatch.primaryArtist($0.artistName)) >= 0.5
    }
    let best = eligible.max { a, b in
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
    guard canTransport else { return }
    if isFollowing {
      if let hint = await spotifyRemote?.remoteTogglePlayPause() { flash(hint) }
      isPlaying = followClock?.isPlaying() ?? isPlaying
      playbackTime = followClock?.now() ?? playbackTime
      return
    }
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

  @Published private(set) var stageSeekRevision = 0

  func seek(to time: TimeInterval) {
    stageSeekRevision += 1
    guard canTransport else { return }
    let target = PlaybackSkip.clamped(time: time, delta: 0, duration: nowPlaying?.duration ?? demoClock?.duration)
    if isFollowing {
      Task { await seekFollow(to: target) }
      return
    }
    if let demoClock {
      demoClock.seek(to: target)
      playbackTime = demoClock.now()
      return
    }
    player.playbackTime = target
    playbackTime = player.playbackTime
  }

  func seekBy(_ delta: TimeInterval) {
    stageSeekRevision += 1
    guard canTransport else { return }
    if isFollowing {
      let target = PlaybackSkip.clamped(
        time: followClock?.now() ?? playbackTime,
        delta: delta,
        duration: nowPlaying?.duration
      )
      Task { await seekFollow(to: target) }
      return
    }
    if let demoClock {
      demoClock.seek(to: PlaybackSkip.clamped(time: demoClock.now(), delta: delta, duration: demoClock.duration))
      playbackTime = demoClock.now()
      return
    }
    player.playbackTime = PlaybackSkip.clamped(
      time: player.playbackTime,
      delta: delta,
      duration: nowPlaying?.duration
    )
    playbackTime = player.playbackTime
  }

  func skipNext() async {
    guard canSkipTracks else { return }
    if isFollowing {
      if let hint = await spotifyRemote?.remoteSkipNext() { flash(hint) }
      return
    }
    do { try await player.skipToNextEntry() }
    catch { flash(error.localizedDescription) }
  }

  func skipPrevious() async {
    guard canTransport else { return }
    if isFollowing {
      let t = followClock?.now() ?? playbackTime
      if PlaybackSkip.shouldRestartCurrent(at: t) {
        await seekFollow(to: 0)
        return
      }
      if let hint = await spotifyRemote?.remoteSkipPrevious() { flash(hint) }
      return
    }
    if let demoClock {
      if PlaybackSkip.shouldRestartCurrent(at: demoClock.now()) {
        demoClock.restart()
        playbackTime = 0
      }
      return
    }
    if PlaybackSkip.shouldRestartCurrent(at: player.playbackTime) {
      player.restartCurrentEntry()
      playbackTime = 0
      return
    }
    do { try await player.skipToPreviousEntry() }
    catch { flash(error.localizedDescription) }
  }

  private func seekFollow(to time: TimeInterval) async {
    guard let remote = spotifyRemote else { return }
    if let hint = await remote.remoteSeek(to: time) {
      flash(hint)
      return
    }
    playbackTime = time
  }

  func toggleShuffle() {
    guard canControlQueue else { return }
    let next: MusicPlayer.ShuffleMode = shuffleEnabled ? .off : .songs
    player.state.shuffleMode = next
    shuffleEnabled = next == .songs
  }

  func cycleRepeat() {
    guard canControlQueue else { return }
    let next = repeatCycle.next
    player.state.repeatMode = next.musicKit
    repeatCycle = next
  }

  func toggleLove() async {
    guard canLove, !isLoving, let id = catalogSongID else { return }
    isLoving = true
    defer { isLoving = false }
    let next = !isLoved
    do {
      try await AppleMusicSocial.setLoved(next, songID: id)
      isLoved = next
      flash(next ? "Loved in Apple Music" : "Removed love")
    } catch {
      flash("Couldn’t update Love in Apple Music")
    }
  }

  func addCurrentToLibrary() async {
    guard canAddToLibrary, !isAddingToLibrary, !isInLibrary, let song = currentSong else { return }
    isAddingToLibrary = true
    defer { isAddingToLibrary = false }
    do {
      try await MusicLibrary.shared.add(song)
      isInLibrary = true
      flash("Added to your library")
    } catch let error as MusicLibrary.Error where error == .itemAlreadyAdded {
      isInLibrary = true
      flash("Already in your library")
    } catch {
      flash("Couldn’t add this song to your library")
    }
  }

  // MARK: - Internals

  private func attachSystemPlayer() async {
    startObservingPlayer()
    startTicking()
    try? await player.prepareToPlay()
    pollPlayer()
  }

  /// Queue and state publish *willChange* before the new values land, so the
  /// extra main-queue hop is load-bearing — reading in the sink itself is stale.
  private func startObservingPlayer() {
    guard playerCancellables.isEmpty else { return }
    let hop = { [weak self] in
      DispatchQueue.main.async { self?.pollPlayer() }
    }
    player.queue.objectWillChange.sink { _ in hop() }.store(in: &playerCancellables)
    player.state.objectWillChange.sink { _ in hop() }.store(in: &playerCancellables)
  }

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
    switch MusicPlaybackPriority.resolve(
      systemMusicPlaying: isSystemMusicPlaying,
      hasDemo: demoClock != nil,
      hasFollow: followClock != nil,
      appleMusicAuthorized: authStatus == .authorized
    ) {
    case .systemMusic:
      if demoClock != nil {
        demoClock?.pause()
        demoClock = nil
      }
      followClock = nil
      adoptSystemPlayback()
    case .demo:
      guard let demoClock else { return }
      isPlaying = demoClock.isPlaying()
      playbackTime = demoClock.now()
    case .follow:
      guard let followClock else { return }
      isPlaying = followClock.isPlaying()
      playbackTime = followClock.now()
    case .systemQueue:
      adoptSystemPlayback()
    case .idle:
      break
    }
  }

  private func adoptSystemPlayback() {
    isPlaying = player.state.playbackStatus == .playing
    playbackTime = player.playbackTime
    shuffleEnabled = player.state.shuffleMode == .songs
    repeatCycle = RepeatCycle(player.state.repeatMode)
    guard let entry = player.queue.currentEntry,
          let track = track(from: entry)
    else { return }
    applyNowPlaying(track)
  }

  private func track(from entry: MusicPlayer.Queue.Entry) -> NowPlayingTrack? {
    if let item = entry.item {
      switch item {
      case .song(let song):
        return track(from: song)
      case .musicVideo:
        currentSong = nil
        return nil
      @unknown default:
        break
      }
    }
    let title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else {
      currentSong = nil
      return nil
    }
    return NowPlayingTrack(
      id: entry.id,
      title: title,
      artist: entry.subtitle ?? "",
      album: "",
      duration: nil,
      artworkURL: entry.artwork?.url(width: 600, height: 600)
    )
  }

  private func track(from song: Song) -> NowPlayingTrack {
    currentSong = song
    return NowPlayingTrack(
      id: song.id.rawValue,
      title: song.title,
      artist: song.artistName,
      album: song.albumTitle ?? "",
      duration: song.duration,
      artworkURL: song.artwork?.url(width: 600, height: 600),
      recording: RecordingIdentity(appleMusicID: song.id.rawValue, isrc: song.isrc)
    )
  }

  private func applyNowPlaying(_ track: NowPlayingTrack) {
    let previousID = nowPlaying?.id
    if nowPlaying != track { nowPlaying = track }
    statusMessage = "Apple Music"
    if previousID != track.id {
      remember(CatalogItem(
        id: track.recording?.appleMusicID ?? track.id,
        title: track.title,
        artist: track.artist,
        album: track.album.isEmpty ? nil : track.album,
        artworkURL: track.artworkURL,
        duration: track.duration,
        recording: track.recording
      ))
      refreshSocial(for: track)
    }
  }

  private func refreshSocial(for track: NowPlayingTrack) {
    socialTask?.cancel()
    isLoved = false
    isInLibrary = currentSong?.libraryAddedDate != nil
    guard let id = catalogSongID else { return }
    let song = currentSong
    socialTask = Task { [weak self] in
      let loved = await AppleMusicSocial.isLoved(songID: id)
      guard !Task.isCancelled else { return }
      self?.isLoved = loved
      if song?.libraryAddedDate != nil {
        self?.isInLibrary = true
      }
    }
  }

  private func clearSocial() {
    socialTask?.cancel()
    isLoved = false
    isInLibrary = false
    shuffleEnabled = false
    repeatCycle = .off
    actionHint = nil
  }

  private func flash(_ text: String) {
    actionHint = text
    hintTask?.cancel()
    hintTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2.4))
      guard !Task.isCancelled else { return }
      if self?.actionHint == text { self?.actionHint = nil }
    }
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
    case "fixture":
      searchResults = DemoBrowseFixture.items; lastSearchTerm = term; isSearching = false
      searchError = nil; errorMessage = nil
    case "empty":
      searchResults = []; lastSearchTerm = term; isSearching = false; errorMessage = nil
    case "loading":
      searchResults = []; lastSearchTerm = nil; isSearching = true; errorMessage = nil
    case "error":
      searchResults = []; lastSearchTerm = term; isSearching = false
      searchError = "The Internet connection appears to be offline."
    default:
      Task { await search(term) }
    }
  }
}

/// Who owns the playhead. Apple Music audio on this TV always wins; the demo
/// and Spotify follow only run when Music is not actually playing.
enum MusicPlaybackPriority: Equatable {
  case systemMusic
  case demo
  case follow
  case systemQueue
  case idle

  static func resolve(
    systemMusicPlaying: Bool,
    hasDemo: Bool,
    hasFollow: Bool,
    appleMusicAuthorized: Bool
  ) -> MusicPlaybackPriority {
    if systemMusicPlaying { return .systemMusic }
    if hasDemo { return .demo }
    if hasFollow { return .follow }
    if appleMusicAuthorized { return .systemQueue }
    return .idle
  }
}
