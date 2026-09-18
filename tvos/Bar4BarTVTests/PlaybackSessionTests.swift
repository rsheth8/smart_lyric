import XCTest
import Bar4BarCore
@testable import Bar4BarTV

@MainActor
private final class MockSpotifyRemote: SpotifyRemoteControlling {
  var commands: [String] = []
  func remoteTogglePlayPause() async -> String? { commands.append("toggle"); return nil }
  func remoteSkipNext() async -> String? { commands.append("next"); return nil }
  func remoteSkipPrevious() async -> String? { commands.append("previous"); return nil }
  func remoteSeek(to time: TimeInterval) async -> String? {
    commands.append("seek:\(Int(time.rounded()))")
    return nil
  }
}

@MainActor
final class PlaybackSessionTests: XCTestCase {
  override func setUp() {
    super.setUp()
    UserDefaults.standard.removeObject(forKey: "bar4bar.tv.languageAid")
    UserDefaults.standard.removeObject(forKey: "bar4bar.tv.singerLead")
  }

  override func tearDown() {
    UserDefaults.standard.removeObject(forKey: "bar4bar.tv.languageAid")
    UserDefaults.standard.removeObject(forKey: "bar4bar.tv.singerLead")
    super.tearDown()
  }

  func testFeatureSwitchRequiresAnExplicitTrueValue() {
    XCTAssertTrue(AppConfig.enabled(true))
    XCTAssertTrue(AppConfig.enabled("YES"))
    XCTAssertTrue(AppConfig.enabled(" true "))
    XCTAssertTrue(AppConfig.enabled(1))
    XCTAssertFalse(AppConfig.enabled(false))
    XCTAssertFalse(AppConfig.enabled("NO"))
    XCTAssertFalse(AppConfig.enabled(""))
    XCTAssertFalse(AppConfig.enabled(nil))
  }

  func testExternalPlaybackOnlyOpensKaraokeFromTheHub() {
    let external = NowPlayingTrack(
      id: "external",
      title: "Song",
      artist: "Artist",
      album: "Album"
    )
    XCTAssertTrue(PlaybackNavigation.shouldPresentKaraoke(
      for: external, isStartingPlayback: false, isAtHub: true, isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldPresentKaraoke(
      for: external, isStartingPlayback: true, isAtHub: true, isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldPresentKaraoke(
      for: external, isStartingPlayback: false, isAtHub: false, isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldPresentKaraoke(
      for: external, isStartingPlayback: false, isAtHub: true, isPlaying: false
    ))
    XCTAssertFalse(PlaybackNavigation.shouldPresentKaraoke(
      for: NowPlayingTrack(id: "demo", title: "Demo", artist: "Bar4Bar", album: "", isDemo: true),
      isStartingPlayback: false,
      isAtHub: true,
      isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldPresentKaraoke(
      for: nil, isStartingPlayback: false, isAtHub: true, isPlaying: true
    ))
    XCTAssertTrue(PlaybackNavigation.shouldOpenFollowKaraoke(
      connected: true, hasTrack: true, isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldOpenFollowKaraoke(
      connected: true, hasTrack: true, isPlaying: false
    ))
    XCTAssertFalse(PlaybackNavigation.shouldOpenFollowKaraoke(
      connected: true, hasTrack: false, isPlaying: true
    ))
    XCTAssertFalse(PlaybackNavigation.shouldOpenFollowKaraoke(
      connected: false, hasTrack: true, isPlaying: true
    ))
  }

  func testFeatureSwitchOnlyAcceptsExplicitTrueValues() {
    XCTAssertTrue(AppConfig.enabled(true))
    XCTAssertTrue(AppConfig.enabled("YES"))
    XCTAssertTrue(AppConfig.enabled(" true "))
    XCTAssertTrue(AppConfig.enabled(1))
    XCTAssertFalse(AppConfig.enabled(false))
    XCTAssertFalse(AppConfig.enabled("NO"))
    XCTAssertFalse(AppConfig.enabled("unexpected"))
    XCTAssertFalse(AppConfig.enabled(nil))
  }

  func testAppleMusicAudioOutranksDemoAndSpotifyFollow() {
    XCTAssertEqual(
      MusicPlaybackPriority.resolve(
        systemMusicPlaying: true, hasDemo: true, hasFollow: true, appleMusicAuthorized: true
      ),
      .systemMusic
    )
    XCTAssertEqual(
      MusicPlaybackPriority.resolve(
        systemMusicPlaying: false, hasDemo: true, hasFollow: true, appleMusicAuthorized: true
      ),
      .demo
    )
    XCTAssertEqual(
      MusicPlaybackPriority.resolve(
        systemMusicPlaying: false, hasDemo: false, hasFollow: true, appleMusicAuthorized: true
      ),
      .follow
    )
    XCTAssertEqual(
      MusicPlaybackPriority.resolve(
        systemMusicPlaying: false, hasDemo: false, hasFollow: false, appleMusicAuthorized: true
      ),
      .systemQueue
    )
    XCTAssertEqual(
      MusicPlaybackPriority.resolve(
        systemMusicPlaying: false, hasDemo: false, hasFollow: false, appleMusicAuthorized: false
      ),
      .idle
    )
  }

  func testListenAndSingLeadPresets() {
    let session = LyricsSession()
    session.setSingerLead(DisplayMath.singerLeadListen)
    XCTAssertEqual(session.singerLead, 0, accuracy: 1e-9)
    session.setSingerLead(DisplayMath.singerLead)
    XCTAssertEqual(session.singerLead, 0.12, accuracy: 1e-9)
    XCTAssertEqual(session.performanceMode, .sing)
    session.togglePerformanceMode()
    XCTAssertEqual(session.performanceMode, .listen)
    XCTAssertEqual(session.singerLead, 0, accuracy: 1e-9)
    session.togglePerformanceMode()
    XCTAssertEqual(session.performanceMode, .sing)
  }

  func testLicensedRichsyncIsShownAndNotWrittenToCache() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = TimelineCache(directory: directory)
    let track = NowPlayingTrack(id: UUID().uuidString, title: "Licensed Song", artist: "Test",
                                album: "", duration: 30, recording: .init(spotifyID: "sp-licensed"))
    let key = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration,
                                     recording: track.recording)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [LicensedRichsyncProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let session = LyricsSession(client: LyricsClient(apiBaseURL: URL(string: "https://lyrics.test"), session: network), cache: cache)
    await session.load(for: track)
    XCTAssertEqual(session.timeline.source, "richsync")
    XCTAssertNil(cache.load(key: key))
  }

  func testRepeatedSyncNudgesAccumulateAndReset() {
    let session = LyricsSession()
    for _ in 0..<10 { session.nudgeSync(by: 0.05) }
    XCTAssertEqual(session.syncOffset, 0.5, accuracy: 0.0001)
    for _ in 0..<4 { session.nudgeSync(by: -0.05) }
    XCTAssertEqual(session.syncOffset, 0.3, accuracy: 0.0001)
    session.resetSync()
    XCTAssertEqual(session.syncOffset, 0)
  }

  func testCachedTrackRestoresOffsetAndClearsLoading() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = TimelineCache(directory: directory)
    let track = NowPlayingTrack(id: UUID().uuidString, title: UUID().uuidString,
                                artist: "Test", album: "", duration: 30)
    let key = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration)
    cache.save(LRC.parse("[00:01.00]Original test line"), key: key)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [UpgradeLyricsProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let session = LyricsSession(client: LyricsClient(session: network), cache: cache)
    await session.load(for: track)
    session.nudgeSync(by: 0.15)
    session.clear()
    await session.load(for: track)
    XCTAssertFalse(session.timeline.isEmpty)
    XCTAssertFalse(session.isLoading)
    XCTAssertEqual(session.syncOffset, 0.15, accuracy: 0.0001)
    session.resetSync()
  }

  func testOlderLyricsCannotReplaceDemoOrResurrectClearedSession() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [DelayedLyricsProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let cache = TimelineCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let session = LyricsSession(client: LyricsClient(session: network), cache: cache)
    let track = NowPlayingTrack(id: "old", title: "Old song", artist: "Test", album: "", duration: 30)
    let music = MusicPlayerService()
    for clear in [false, true] {
      let started = expectation(description: "Request started")
      DelayedLyricsProtocol.onStart = { started.fulfill() }
      let loading = Task { await session.load(for: track) }
      await fulfillment(of: [started], timeout: 3)
      XCTAssertTrue(session.isLoading)
      XCTAssertTrue(session.timeline.isEmpty)
      if clear { session.clear() }
      else {
        music.startDemo()
        await session.load(for: music.nowPlaying!)
      }
      await loading.value
      XCTAssertFalse(session.isLoading)
      if clear { XCTAssertTrue(session.timeline.isEmpty) }
      else { XCTAssertEqual(session.timeline, DemoSong.timeline()) }
    }
    music.stopDemo()
  }

  func testCachedEstimateUpgradesToRealWordTiming() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [UpgradeLyricsProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let cache = TimelineCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let track = NowPlayingTrack(id: "upgrade", title: "Upgrade", artist: "Test", album: "", duration: 30)
    let key = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration)
    cache.save(LRC.parse("[00:01.00]Fallback words"), key: key)
    let session = LyricsSession(client: LyricsClient(apiBaseURL: URL(string: "https://lyrics.test"), session: network), cache: cache)
    await session.load(for: track)
    XCTAssertTrue(session.timeline.hasWordTiming)
    XCTAssertEqual(session.statusMessage, "Word-synced lyrics")
    XCTAssertTrue(cache.load(key: key)?.hasWordTiming == true)
    XCTAssertFalse(session.isLoading)
  }

  func testFollowingCannotOperateAppleMusicAndDemoTakesOwnership() async {
    let music = MusicPlayerService()
    let clock = StreamingClock(isPlaying: { true })
    clock.set(20)
    let item = CatalogItem(id: "", title: "Original", artist: "Test", duration: 60)
    music.beginFollowing(clock, track: item, sourceLabel: "Spotify")
    XCTAssertTrue(music.isFollowing)
    XCTAssertTrue(music.isPlaying)
    await music.togglePlayPause()
    XCTAssertNil(music.errorMessage)
    XCTAssertTrue(music.isFollowing)
    music.startDemo()
    XCTAssertFalse(music.isFollowing)
    XCTAssertTrue(music.isDemo)
    music.stopFollowing()
    XCTAssertTrue(music.isDemo)
    music.stopDemo()
  }

  func testDemoTransportSeeksAndPreviousRestartsAfterThreshold() async {
    let music = MusicPlayerService()
    music.startDemo()
    XCTAssertTrue(music.canTransport)
    XCTAssertFalse(music.canControlQueue)
    XCTAssertFalse(music.canLove)
    music.seekBy(10)
    XCTAssertEqual(music.playbackTime, 10, accuracy: 0.05)
    await music.skipPrevious()
    XCTAssertEqual(music.playbackTime, 0, accuracy: 0.05)
    music.seekBy(2)
    await music.skipPrevious()
    XCTAssertEqual(music.playbackTime, 2, accuracy: 0.05)
    music.seekBy(PlaybackSkip.nudge)
    XCTAssertEqual(music.playbackTime, 17, accuracy: 0.05)
    music.seek(to: 21.2)
    XCTAssertEqual(music.playbackTime, 21.2, accuracy: 0.05)
    music.stopDemo()
  }

  func testSpotifyFollowIgnoresLocalTransport() async {
    let music = MusicPlayerService()
    let clock = StreamingClock(isPlaying: { true })
    clock.set(20)
    music.beginFollowing(
      clock,
      track: CatalogItem(id: "", title: "Original", artist: "Test", duration: 60),
      sourceLabel: "Spotify"
    )
    XCTAssertTrue(music.canTransport)
    XCTAssertTrue(music.canSkipTracks)
    XCTAssertFalse(music.canControlQueue)
    music.seekBy(15)
    XCTAssertEqual(music.playbackTime, 20, accuracy: 0.05)
    await music.skipNext()
    await music.skipPrevious()
    XCTAssertEqual(music.nowPlaying?.title, "Original")
    music.stopFollowing()
  }

  func testSpotifyFollowRoutesTransportToRemote() async {
    let music = MusicPlayerService()
    let remote = MockSpotifyRemote()
    music.spotifyRemote = remote
    let clock = StreamingClock(isPlaying: { true })
    clock.set(20)
    music.beginFollowing(
      clock,
      track: CatalogItem(id: "", title: "Original", artist: "Test", duration: 60),
      sourceLabel: "Spotify"
    )
    await music.togglePlayPause()
    await music.skipNext()
    await music.skipPrevious()
    music.seekBy(15)
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(remote.commands, ["toggle", "next", "seek:0", "seek:35"])
    music.stopFollowing()
  }

  func testRepeatCycleAndSkipMath() {
    XCTAssertEqual(RepeatCycle.off.next, .all)
    XCTAssertEqual(RepeatCycle.all.next, .one)
    XCTAssertEqual(RepeatCycle.one.next, .off)
    XCTAssertTrue(PlaybackSkip.shouldRestartCurrent(at: 3.01))
    XCTAssertFalse(PlaybackSkip.shouldRestartCurrent(at: 2.5))
    XCTAssertEqual(PlaybackSkip.clamped(time: 10, delta: 15, duration: 20), 20)
    XCTAssertEqual(PlaybackSkip.clamped(time: 2, delta: -15, duration: 20), 0)
  }

  func testAppleMusicLoveRatingPayload() {
    let loved = Data(#"{"data":[{"id":"1","type":"ratings","attributes":{"value":1}}]}"#.utf8)
    let disliked = Data(#"{"data":[{"id":"1","type":"ratings","attributes":{"value":-1}}]}"#.utf8)
    XCTAssertEqual(AppleMusicSocial.parseRating(from: loved), 1)
    XCTAssertEqual(AppleMusicSocial.parseRating(from: disliked), -1)
    XCTAssertNil(AppleMusicSocial.parseRating(from: Data("{}".utf8)))
  }

  func testFollowingChangesRecordingEvenWhenDisplayMetadataIsIdentical() {
    let music = MusicPlayerService()
    let clock = StreamingClock(isPlaying: { true })
    let first = CatalogItem(id: "", title: "Song", artist: "Test", duration: 30,
      recording: .init(spotifyID: "edition-a", explicit: true))
    let second = CatalogItem(id: "", title: "Song", artist: "Test", duration: 30,
      recording: .init(spotifyID: "edition-b", explicit: false))
    music.beginFollowing(clock, track: first, sourceLabel: "Spotify")
    let oldID = music.nowPlaying?.id
    music.beginFollowing(clock, track: second, sourceLabel: "Spotify")
    XCTAssertNotEqual(oldID, music.nowPlaying?.id)
    XCTAssertEqual(music.nowPlaying?.recording, second.recording)
    music.stopFollowing()
  }

  func testCachedWordsRevalidateWithoutDowngradingOnProviderFailure() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [UpgradeLyricsProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let cache = TimelineCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let track = NowPlayingTrack(id: "upgrade", title: "Upgrade", artist: "Test", album: "", duration: 30)
    let key = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration)
    let saved = YRC.parse("[1000,3000](1000,500,0)Old (2000,500,0)words")
    cache.save(Timeline(lines: saved.lines, source: "yrc"), key: key)
    let session = LyricsSession(client: LyricsClient(apiBaseURL: URL(string: "https://lyrics.test"), session: network), cache: cache)
    await session.load(for: track)
    XCTAssertEqual(session.timeline.lines.first?.words.first?.text.trimmingCharacters(in: .whitespaces), "Upgrade")
    session.configure(apiBase: nil)
    await session.load(for: track)
    XCTAssertTrue(session.timeline.hasWordTiming)
  }

  func testDisconnectDropsSpotifyClock() {
    let spotify = SpotifyService()
    spotify.disconnect()
    XCTAssertNil(spotify.followClock)
    XCTAssertNil(spotify.track)
    XCTAssertNil(spotify.nextUp)
    XCTAssertFalse(spotify.isPlaying)
    XCTAssertEqual(spotify.state, .disconnected)
  }

  func testPrefetchedNextSongIsReadyBeforeTheTrackChangeFetch() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = TimelineCache(directory: directory)
    let upcoming = NowPlayingTrack(
      id: "follow:next1",
      title: "Next Song",
      artist: "Artist",
      album: "Album",
      duration: 181,
      recording: .init(spotifyID: "next1")
    )
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [NextSongLyricsProtocol.self]
    let network = URLSession(configuration: config)
    defer { network.invalidateAndCancel() }
    let session = LyricsSession(
      client: LyricsClient(apiBaseURL: URL(string: "https://lyrics.test"), session: network),
      cache: cache
    )
    session.prepareNext(upcoming)
    XCTAssertEqual(session.nextPrepTitle, "Next Song")
    let prefetched = await session.takeNextPrep(for: upcoming, waitNs: 2_000_000_000)
    XCTAssertNil(session.nextPrepTitle)
    XCTAssertFalse(session.nextPrepReady)
    XCTAssertEqual(prefetched?.timeline.lines.first?.text, "Already lined up")
    XCTAssertEqual(
      LyricsSession.prepDetail(for: try XCTUnwrap(prefetched)),
      "Word-synced · 3 words · yrc"
    )
    NextSongLyricsProtocol.failSubsequent = true
    defer { NextSongLyricsProtocol.failSubsequent = false }
    await session.load(for: upcoming)
    XCTAssertEqual(session.timeline.lines.first?.text, "Already lined up")
    XCTAssertFalse(session.isLoading)
  }

  func testPrepareNextSkipsTheSongAlreadyOnScreen() async {
    let session = LyricsSession()
    let current = NowPlayingTrack(id: "now", title: "Now", artist: "A", album: "")
    session.prepareNext(current, skipIf: current)
    let taken = await session.takeNextPrep(for: current, waitNs: 100_000_000)
    XCTAssertNil(taken)
  }

  func testEnglishSongsSkipPronunciationAndFillTranslation() async {
    let (session, cache) = await loadedSession(
      lyrics: "[00:01.00]Hello world\n[00:05.00]Second line",
      aid: StubLanguageAid(english: ["Hi world", "Line two"], roman: nil)
    )
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    XCTAssertFalse(session.romanApplies)
    await session.cycleAid()
    XCTAssertEqual(session.aidMode, .english)
    XCTAssertEqual(session.timeline.lines.map(\.english), ["Hi world", "Line two"])
    await session.cycleAid()
    XCTAssertEqual(session.aidMode, .off)
    XCTAssertEqual(session.preferredAidMode, .off)
  }

  func testNonLatinSongsGetOnDevicePronunciationWhenCatalogHasNone() async {
    let (session, cache) = await loadedSession(
      lyrics: "[00:01.00]夜に駆ける\n[00:05.00]君はまだ",
      aid: StubLanguageAid(english: ["Racing into the night", "You still"], roman: nil)
    )
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    XCTAssertTrue(session.romanApplies)
    await session.cycleAid()
    XCTAssertEqual(session.aidMode, .roman)
    XCTAssertTrue(session.timeline.hasRoman)
    XCTAssertEqual(session.timeline.lines[0].roman, LanguageAid.localRomanize("夜に駆ける"))
    await session.cycleAid()
    XCTAssertEqual(session.aidMode, .english)
    XCTAssertEqual(session.timeline.lines[0].english, "Racing into the night")
  }

  func testPreferredEnglishRestoresAfterReload() async {
    UserDefaults.standard.set(LanguageAidMode.english.rawValue, forKey: "bar4bar.tv.languageAid")
    let (session, cache) = await loadedSession(
      lyrics: "[00:01.00]Hello world\n[00:05.00]Second line",
      aid: StubLanguageAid(english: ["Hi world", "Line two"], roman: nil)
    )
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    XCTAssertEqual(session.aidMode, .english)
    XCTAssertEqual(session.timeline.lines[1].english, "Line two")
  }

  private func loadedSession(lyrics: String, aid: StubLanguageAid) async -> (LyricsSession, TimelineCache) {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [UpgradeLyricsProtocol.self]
    let network = URLSession(configuration: config)
    let cache = TimelineCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    let track = NowPlayingTrack(id: UUID().uuidString, title: "Aid Song", artist: "Test", album: "", duration: 30)
    let key = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration)
    cache.save(LRC.parse(lyrics), key: key)
    let session = LyricsSession(
      client: LyricsClient(session: network),
      cache: cache,
      languageAid: aid
    )
    await session.load(for: track)
    return (session, cache)
  }
}

private struct StubLanguageAid: LanguageAiding, Sendable {
  var english: [String]?
  var roman: [String]?
  func translateLines(_ lines: [String], to: String) async -> [String]? { english }
  func romanizeLines(_ lines: [String]) async -> [String]? { roman }
}

final class DelayedLyricsProtocol: URLProtocol, @unchecked Sendable {
  static var onStart: (() -> Void)?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.onStart?()
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in
      let body = #"[{"trackName":"Old song","artistName":"Test","duration":30,"syncedLyrics":"[00:01.00]Old response"}]"#
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
                          httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}
}

private final class LicensedRichsyncProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body: String
    if request.url!.path == "/api/richsync" {
      body = #"{"richsync":"[{\"ts\":1,\"te\":2,\"x\":\"hi\",\"l\":[{\"c\":\"hi\",\"o\":0}]}]","licensed":true,"cacheable":false,"meta":{"trackName":"Licensed Song","artistName":"Test","duration":30}}"#
    } else {
      body = "{}"
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private final class NextSongLyricsProtocol: URLProtocol, @unchecked Sendable {
  static var failSubsequent = false
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if Self.failSubsequent {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
    let body = request.url!.path == "/api/lyrics"
      ? #"{"yrc":"[1000,2000](1000,500,0)Already (1500,500,0)lined (2000,400,0)up","meta":{"trackName":"Next Song","artistName":"Artist","duration":181}}"#
      : "{}"
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private final class UpgradeLyricsProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body = request.url!.path == "/api/lyrics"
      ? #"{"yrc":"[1000,3000](1000,500,0)Upgrade (2000,500,0)words","meta":{"trackName":"Upgrade","artistName":"Test","duration":30}}"#
      : "{}"
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
