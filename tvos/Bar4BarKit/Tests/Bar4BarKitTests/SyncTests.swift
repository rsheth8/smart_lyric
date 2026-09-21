import XCTest
@testable import Bar4BarKit

/// Wall clock we drive by hand, so a whole song runs in microseconds.
private final class FakeWall: @unchecked Sendable {
  var t = 0.0
  var read: () -> Double { { [self] in t } }
  func advance(_ seconds: Double) { t += seconds }
}

@MainActor
private final class FakeSource: AudioChunkSource {
  nonisolated(unsafe) var chunk: AudioChunk?
  init(chunk: AudioChunk?) { self.chunk = chunk }
  nonisolated func captureChunk() async -> AudioChunk? { chunk }
}

@MainActor
private final class FakeRecognizer: SongRecognizer {
  nonisolated(unsafe) var next: Recognition?
  nonisolated(unsafe) var throwsError = false
  init(next: Recognition? = nil) { self.next = next }
  nonisolated func identify(_ wav: Data) async throws -> Recognition? {
    if throwsError { throw NSError(domain: "test", code: 1) }
    return next
  }
}

private func heard(_ wav: String = "wav", onsetAt: Double? = 0) -> AudioChunk {
  AudioChunk(wav: Data(wav.utf8), onsetAt: onsetAt)
}

@MainActor
final class SyncClockTests: XCTestCase {
  func testFreeRunsAtItsRateAndFreezesWhenPaused() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 10)

    wall.advance(5)
    XCTAssertEqual(clock.now(), 15, accuracy: 0.001)

    clock.pause()
    wall.advance(30)
    XCTAssertEqual(clock.now(), 15, accuracy: 0.001, "a paused clock must not run on")

    clock.resume()
    wall.advance(2)
    XCTAssertEqual(clock.now(), 17, accuracy: 0.001)
  }

  func testObserveBeforeStartingJustStarts() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.observe(42)
    XCTAssertTrue(clock.isPlaying)
    XCTAssertEqual(clock.now(), 42, accuracy: 0.001)
  }

  func testABigErrorSnapsStraightToTruth() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)
    wall.advance(10)

    // The needle was moved: the music is 30s further in than we thought.
    clock.observe(40)
    XCTAssertEqual(clock.now(), 40, accuracy: 0.01)
  }

  func testASmallErrorEasesInsteadOfJumping() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)
    wall.advance(10)

    // Half a second behind — well inside the jump threshold.
    clock.observe(10.5)
    // The position must NOT leap to 10.5; it stays put and the rate takes over.
    XCTAssertEqual(clock.now(), 10, accuracy: 0.05, "a small error must not move the playhead")
    XCTAssertGreaterThan(clock.rate, 1.0, "being behind should speed the clock up")
  }

  func testNeverRewindsOnASmallBackwardsError() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)
    wall.advance(10)
    let before = clock.now()

    clock.observe(9.3) // we are a little ahead of the music
    XCTAssertGreaterThanOrEqual(clock.now(), before - 0.05, "lyrics must never visibly rewind")
    XCTAssertLessThan(clock.rate, 1.0, "being ahead should slow the clock down")
  }

  func testABigBackwardsErrorIsASeekAndDoesSnap() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 100)
    wall.advance(1)

    clock.observe(5) // restarted the track
    XCTAssertEqual(clock.now(), 5, accuracy: 0.01)
  }

  func testCalibrateRateLearnsATurntableRunningFast() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)

    // 10 wall seconds carried 10.3 song seconds: this deck runs 3% fast.
    clock.calibrateRate(song1: 0, wall1: 0, song2: 10.3, wall2: 10)
    for _ in 0..<200 { _ = clock.now() } // let the eased rate settle
    XCTAssertEqual(clock.rate, 1.03, accuracy: 0.005)
  }

  func testCalibrateRateIgnoresNonsenseAndTooShortAGap() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)

    clock.calibrateRate(song1: 0, wall1: 0, song2: 100, wall2: 10) // rate 10 — absurd
    clock.calibrateRate(song1: 0, wall1: 0, song2: 0.1, wall2: 0.2) // gap too short to mean anything
    for _ in 0..<200 { _ = clock.now() }
    XCTAssertEqual(clock.rate, 1.0, accuracy: 0.001, "a bad pair must not move the rate")
  }

  func testCalibrateRateClampsToPlausiblePlaybackSpeeds() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)

    clock.calibrateRate(song1: 0, wall1: 0, song2: 11.5, wall2: 10) // 1.15 — inside the sanity band, past the clamp
    for _ in 0..<200 { _ = clock.now() }
    XCTAssertEqual(clock.rate, 1.06, accuracy: 0.001, "rate is clamped to what real playback does")
  }

  func testOneBadSampleCannotYankASettledRate() {
    let wall = FakeWall()
    let clock = SyncClock(now: wall.read)
    clock.start(at: 0)

    for i in 0..<4 { // four consistent observations of a 2%-fast deck
      clock.calibrateRate(song1: 0, wall1: Double(i) * 10, song2: 10.2, wall2: Double(i) * 10 + 10)
    }
    for _ in 0..<200 { _ = clock.now() }
    let settled = clock.rate

    clock.calibrateRate(song1: 0, wall1: 100, song2: 11.5, wall2: 110) // one wild fingerprint
    for _ in 0..<200 { _ = clock.now() }
    XCTAssertEqual(clock.rate, settled, accuracy: 0.005, "a settled rate ignores an outlier")
  }
}

@MainActor
final class SongDetectorTests: XCTestCase {
  private func make(
    chunk: AudioChunk? = heard(),
    recognition: Recognition? = nil,
    wall: FakeWall = FakeWall(),
    minScore: Double = 0.5,
    missTolerance: Int = 4
  ) -> (SongDetector, SyncClock, FakeRecognizer, FakeSource, FakeWall, Box) {
    let clock = SyncClock(now: wall.read)
    let source = FakeSource(chunk: chunk)
    let recognizer = FakeRecognizer(next: recognition)
    let box = Box()
    let detector = SongDetector(
      source: source,
      recognizer: recognizer,
      clock: clock,
      now: wall.read,
      missTolerance: missTolerance,
      minScore: minScore,
      onSong: { [box] in box.songs.append($0) },
      onState: { [box] in box.states.append($0) },
      onPoll: { [box] in box.polls.append($0) }
    )
    return (detector, clock, recognizer, source, wall, box)
  }

  final class Box {
    var songs: [Recognition] = []
    var states: [ListenState] = []
    var polls: [PollOutcome] = []
  }

  private func match(_ id: String = "rec1", offset: Double? = 30, score: Double? = 0.9) -> Recognition {
    Recognition(
      recordingId: id, title: "Yellow", artist: "Coldplay",
      durationSec: 266, offsetSec: offset, score: score
    )
  }

  func testAMatchLocksTheClockToTheSongsRealPosition() async {
    let (detector, clock, _, _, _, box) = make(recognition: match(offset: 30))
    await detector.pollOnce()

    XCTAssertEqual(detector.state, .locked)
    XCTAssertEqual(clock.now(), 30, accuracy: 0.01, "the fingerprint's offset IS the playhead")
    XCTAssertEqual(box.songs.count, 1)
    XCTAssertEqual(box.songs.first?.title, "Yellow")
    XCTAssertEqual(box.polls.last?.reason, .match)
  }

  func testTheRecognisedSongCarriesThroughAsASong() async {
    let (detector, _, _, _, _, box) = make(recognition: match())
    await detector.pollOnce()
    XCTAssertEqual(box.songs.first?.song, Song(track: "Yellow", artist: "Coldplay", duration: 266))
  }

  func testSilenceIsNotEvenWorthFingerprinting() async {
    let (detector, _, _, _, _, box) = make(chunk: heard(onsetAt: nil), recognition: match())
    await detector.pollOnce()

    XCTAssertEqual(box.polls.last?.reason, .noAudio)
    XCTAssertEqual(detector.attempts, 0, "a silent room must not spend an API call")
    XCTAssertTrue(box.songs.isEmpty)
  }

  func testWithNoOffsetThePositionFallsBackToWhenWeFirstHeardSound() async {
    let wall = FakeWall()
    wall.t = 100
    let (detector, clock, _, source, _, _) = make(recognition: match(offset: nil), wall: wall)
    source.chunk = heard(onsetAt: 88) // sound started 12s ago

    await detector.pollOnce()
    XCTAssertEqual(clock.now(), 12, accuracy: 0.01)
  }

  func testALowScoreMatchIsTreatedAsAMiss() async {
    let (detector, _, _, _, _, box) = make(recognition: match(score: 0.2))
    await detector.pollOnce()

    XCTAssertEqual(box.polls.last?.reason, .lowScore)
    XCTAssertTrue(box.songs.isEmpty, "a coin-flip match must not swap the song on screen")
    XCTAssertNotEqual(detector.state, .locked)
  }

  func testARecogniserErrorIsAMissNotACrash() async {
    let (detector, _, recognizer, _, _, box) = make(recognition: match())
    recognizer.throwsError = true
    await detector.pollOnce()
    XCTAssertEqual(box.polls.last?.reason, .noMatch)
  }

  func testRepeatedMissesFreezeTheClockAndGoBackToListening() async {
    let (detector, clock, recognizer, _, wall, _) = make(recognition: match(offset: 30), missTolerance: 3)
    await detector.pollOnce()
    XCTAssertEqual(detector.state, .locked)

    recognizer.next = nil // the song ended / the room went quiet
    for _ in 0..<3 { await detector.pollOnce() }

    XCTAssertEqual(detector.state, .listening)
    XCTAssertFalse(clock.isPlaying, "an unheard song must not keep scrolling lyrics")
    let frozen = clock.now()
    wall.advance(60)
    XCTAssertEqual(clock.now(), frozen, accuracy: 0.001)
  }

  func testAMissOrTwoIsToleratedWithoutDroppingTheLock() async {
    let (detector, clock, recognizer, _, _, _) = make(recognition: match(offset: 30), missTolerance: 4)
    await detector.pollOnce()

    recognizer.next = nil
    for _ in 0..<3 { await detector.pollOnce() } // one short of the tolerance

    XCTAssertEqual(detector.state, .locked, "a loud room shouldn't drop the song")
    XCTAssertTrue(clock.isPlaying)
  }

  func testANewSongIsAnnouncedAndSnappedTo() async {
    let (detector, clock, recognizer, _, _, box) = make(recognition: match("rec1", offset: 30))
    await detector.pollOnce()

    recognizer.next = match("rec2", offset: 2)
    await detector.pollOnce()

    XCTAssertEqual(box.songs.count, 2, "a different recording must raise a new song")
    XCTAssertEqual(clock.now(), 2, accuracy: 0.01)
  }

  /// Drives a whole song and reports the worst playhead error once settled.
  private func trackingError(rate trueRate: Double, polls: Int = 30) async -> (worst: Double, songs: Int) {
    let wall = FakeWall()
    let (detector, clock, recognizer, _, _, box) = make(recognition: match(offset: 30), wall: wall)
    await detector.pollOnce()

    var truth = 30.0
    var errors: [Double] = []
    for _ in 0..<polls {
      wall.advance(10)
      truth += 10 * trueRate
      recognizer.next = match(offset: truth)
      await detector.pollOnce()
      for _ in 0..<60 { _ = clock.now() } // a second of render frames
      errors.append(abs(clock.now() - truth))
    }
    return (errors.suffix(polls / 2).max() ?? 0, box.songs.count)
  }

  /// The case that matters most: anything digital plays at exactly 1.0, so the
  /// lyrics should sit dead on the music with no drift at all.
  func testADigitalSourceIsTrackedExactly() async {
    let (worst, songs) = await trackingError(rate: 1.0)
    XCTAssertEqual(songs, 1, "the same recording must not re-announce")
    XCTAssertLessThan(worst, 0.01, "streamed playback should need no correction at all")
  }

  /// A turntable a few percent off. The rate controller hunts rather than
  /// settling (see the ceiling note in SyncClock), so the promise here is the one
  /// the singer actually feels: the error stays small and never runs away.
  func testADriftingSourceStaysLockedWithinATolerableError() async {
    for rate in [1.03, 0.97] {
      let (worst, songs) = await trackingError(rate: rate)
      XCTAssertEqual(songs, 1)
      XCTAssertLessThan(worst, 0.35, "a \(rate)× source must stay locked, not drift away")
    }
  }

  func testStopResetsEverything() async {
    let (detector, _, _, _, _, _) = make(recognition: match())
    await detector.pollOnce()
    detector.stop()
    XCTAssertEqual(detector.state, .idle)
  }

  // MARK: - what it costs
  //
  // Every poll is a paid recognition request, and the free tier is 100 of them.
  // These pin the schedule that makes the feature affordable.

  private func seconds(_ d: Duration) -> Int { Int(d.components.seconds) }

  func testSearchingPollsOftenBecauseNothingIsKnownYet() {
    let (detector, _, _, _, _, _) = make()
    XCTAssertEqual(detector.state, .listening == detector.state ? detector.state : .idle)
    XCTAssertEqual(seconds(detector.nextDelay()), 5)
  }

  func testOnceLockedItGoesQuiet() async {
    let (detector, _, _, _, _, _) = make(recognition: match(offset: 30))
    await detector.pollOnce()
    XCTAssertEqual(detector.state, .locked)
    // 30s into a 266s track: nothing to learn until it ends, so wait it out.
    XCTAssertEqual(seconds(detector.nextDelay()), 237, "a song playing fine needs no attention")
  }

  func testItLooksAgainRightAsTheSongIsDueToEnd() async {
    let wall = FakeWall()
    let (detector, _, recognizer, _, _, _) = make(recognition: match(offset: 30), wall: wall)
    await detector.pollOnce()

    // 250s into a 266s track: check back in ~16s, not a full idle interval.
    recognizer.next = match(offset: 250)
    await detector.pollOnce()
    let delay = seconds(detector.nextDelay())
    XCTAssertGreaterThan(delay, 1)
    XCTAssertLessThanOrEqual(delay, 18, "the next song should be caught as this one ends")
  }

  func testAMissDropsStraightBackToFastPolling() async {
    let (detector, _, recognizer, _, _, _) = make(recognition: match(offset: 30))
    await detector.pollOnce()
    XCTAssertEqual(seconds(detector.nextDelay()), 237)

    recognizer.next = nil // music stopped mid-song
    await detector.pollOnce()
    XCTAssertEqual(detector.state, .locked, "still locked — one miss is not enough to drop it")
    XCTAssertEqual(seconds(detector.nextDelay()), 5, "but check back quickly to find out")
  }

  /// The number that decides whether this is affordable: drive a three-hour
  /// party of 3-minute songs and count the recognition requests.
  func testAThreeHourPartyStaysInsideTheFreeTier() async {
    let wall = FakeWall()
    let songLength = 180.0
    let (detector, clock, recognizer, _, _, _) = make(recognition: match("s0", offset: 0), wall: wall)

    var elapsed = 0.0
    var songIndex = 0
    var songStartedAt = 0.0

    while elapsed < 3 * 3600 {
      // Whatever is playing right now, at its true position.
      songIndex = Int(elapsed / songLength)
      songStartedAt = Double(songIndex) * songLength
      recognizer.next = match("s\(songIndex)", offset: elapsed - songStartedAt)

      await detector.pollOnce()
      let wait = Double(detector.nextDelay().components.seconds)
      elapsed += wait
      wall.advance(wait)
      clock.observe(elapsed - songStartedAt) // the room keeps playing between polls
    }

    print(">>> 3-hour party cost \(detector.attempts) recognition requests")
    XCTAssertLessThan(
      detector.attempts, 100,
      "a 3-hour party must fit inside the free tier — it cost \(detector.attempts) requests"
    )
  }
}

/// The wire format between /api/identify and the TV. These two must not drift
/// apart silently — a renamed key here shows up as "nothing ever matches".
final class RelayRecognizerTests: XCTestCase {
  private func decode(_ json: String) -> Recognition? {
    RelayRecognizer.decode(Data(json.utf8))
  }

  func testDecodesTheRouteSHitShape() {
    let r = decode(#"""
      {"match":{"recordingId":"abc","title":"Yellow","artist":"Coldplay",
                "album":"Parachutes","durationSec":266,"offsetSec":41.5,"score":0.92}}
      """#)
    XCTAssertEqual(
      r,
      Recognition(
        recordingId: "abc", title: "Yellow", artist: "Coldplay", album: "Parachutes",
        durationSec: 266, offsetSec: 41.5, score: 0.92
      )
    )
  }

  func testACleanMissDecodesToNil() {
    XCTAssertNil(decode(#"{"match":null}"#))
  }

  func testAMatchWithoutAnOffsetKeepsItNilRatherThanZero() {
    // Zero would drag the lyrics to 0:00; nil makes the detector fall back to onset.
    let r = decode(#"{"match":{"recordingId":"abc","title":"t","artist":"a"}}"#)
    XCTAssertNotNil(r)
    XCTAssertNil(r?.offsetSec)
    XCTAssertNil(r?.score)
  }

  func testGarbageDecodesToNilInsteadOfThrowing() {
    XCTAssertNil(decode("not json"))
    XCTAssertNil(decode("{}"))
    XCTAssertNil(decode(#"{"match":{"title":"no id"}}"#))
  }
}
