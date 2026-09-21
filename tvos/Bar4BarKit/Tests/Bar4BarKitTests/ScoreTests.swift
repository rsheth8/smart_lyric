import XCTest
@testable import Bar4BarKit

final class ScoreModelTests: XCTestCase {
  func testGradeBoundaries() {
    XCTAssertEqual(Score.gradeFor(100), "Superstar")
    XCTAssertEqual(Score.gradeFor(90), "Superstar")
    XCTAssertEqual(Score.gradeFor(89), "Headliner")
    XCTAssertEqual(Score.gradeFor(80), "Headliner")
    XCTAssertEqual(Score.gradeFor(70), "Encore")
    XCTAssertEqual(Score.gradeFor(55), "Warmed up")
    XCTAssertEqual(Score.gradeFor(54), "Keep going")
    XCTAssertEqual(Score.gradeFor(0), "Keep going")
  }

  /// The relay validates `song_scored` against an allowlist in app/analytics.js.
  /// A grade renamed on one side and not the other means the TV's events get
  /// 400'd and silently vanish, so pin the strings.
  func testGradeNamesMatchTheAnalyticsAllowlist() {
    XCTAssertEqual(
      Score.gradeNames,
      ["Superstar", "Headliner", "Encore", "Warmed up", "Keep going"]
    )
  }

  func testPitchAccuracyTapersBetweenToleranceAndCutoff() {
    XCTAssertNil(Score.pitchAccuracy(nil))
    XCTAssertNil(Score.pitchAccuracy(.nan))
    XCTAssertEqual(Score.pitchAccuracy(0), 1)
    XCTAssertEqual(Score.pitchAccuracy(-50), 1) // flat and sharp score the same
    XCTAssertEqual(Score.pitchAccuracy(50), 1)
    XCTAssertEqual(Score.pitchAccuracy(125) ?? -1, 0.5, accuracy: 1e-9)
    XCTAssertEqual(Score.pitchAccuracy(200), 0)
    XCTAssertEqual(Score.pitchAccuracy(1200), 0)
  }

  func testCombineFallsBackToCoverageWithoutAReference() {
    // The TV's only case: no melody to compare against.
    XCTAssertEqual(Score.combine(coverage: 0.8, pitch: nil), 80)
    XCTAssertEqual(Score.combine(coverage: 1, pitch: nil), 100)
    // With a reference, pitch takes its 40% share.
    XCTAssertEqual(Score.combine(coverage: 1, pitch: 0), 60)
    XCTAssertEqual(Score.combine(coverage: 0, pitch: 1), 40)
    // Out-of-range inputs clamp rather than producing a score over 100.
    XCTAssertEqual(Score.combine(coverage: 5, pitch: nil), 100)
    XCTAssertEqual(Score.combine(coverage: -1, pitch: nil), 0)
  }
}

final class ScoreKeeperTests: XCTestCase {
  func testNoCardUntilThereIsEnoughEvidence() {
    let keeper = ScoreKeeper()
    for _ in 0..<(Score.minFrames - 1) { keeper.sample(expected: true, level: 0.5) }
    XCTAssertNil(keeper.result(), "a few seconds of singing is not a performance")
    keeper.sample(expected: true, level: 0.5)
    XCTAssertEqual(keeper.result()?.score, 100)
  }

  func testInstrumentalFramesAreNotHeldAgainstYou() {
    let keeper = ScoreKeeper()
    for _ in 0..<50 { keeper.sample(expected: false, level: 0) }
    XCTAssertNil(keeper.result(), "silence over an instrumental is correct, not a score")

    for _ in 0..<50 { keeper.sample(expected: true, level: 0.5) }
    let result = keeper.result()
    XCTAssertEqual(result?.frames, 50)
    XCTAssertEqual(result?.score, 100)
  }

  func testCoverageIsTheShareOfExpectedFramesThatGotAVoice() {
    let keeper = ScoreKeeper()
    for i in 0..<100 { keeper.sample(expected: true, level: i < 70 ? 0.5 : 0.001) }
    let result = keeper.result()
    XCTAssertEqual(result?.coverage ?? 0, 0.7, accuracy: 1e-9)
    XCTAssertEqual(result?.score, 70)
    XCTAssertEqual(result?.grade, "Encore")
    XCTAssertEqual(result?.scored, false, "no cents were supplied, so pitch judged nothing")
    XCTAssertNil(result?.pitch)
  }

  func testBestStreakSurvivesALaterStumble() {
    let keeper = ScoreKeeper()
    for _ in 0..<30 { keeper.sample(expected: true, level: 0.5) }
    keeper.sample(expected: true, level: 0) // dropped the line
    for _ in 0..<10 { keeper.sample(expected: true, level: 0.5) }
    XCTAssertEqual(keeper.result()?.bestStreak, 30)
  }

  func testAnInstrumentalBreakBreaksTheStreakWithoutScoring() {
    let keeper = ScoreKeeper()
    for _ in 0..<30 { keeper.sample(expected: true, level: 0.5) }
    keeper.sample(expected: false, level: 0.5)
    for _ in 0..<20 { keeper.sample(expected: true, level: 0.5) }
    let result = keeper.result()
    XCTAssertEqual(result?.bestStreak, 30)
    XCTAssertEqual(result?.frames, 50, "the break itself was never an expected frame")
  }

  func testPitchAveragesOnlyOverFramesThatActuallySang() {
    let keeper = ScoreKeeper()
    for _ in 0..<40 { keeper.sample(expected: true, level: 0.5, cents: 0) }
    for _ in 0..<40 { keeper.sample(expected: true, level: 0, cents: 1000) }
    let result = keeper.result()
    XCTAssertEqual(result?.pitch, 1, "a frame with no voice has no pitch to judge")
    XCTAssertEqual(result?.scored, true)
    XCTAssertEqual(result?.coverage ?? 0, 0.5, accuracy: 1e-9)
    XCTAssertEqual(result?.score, 70) // 0.5 * 0.6 + 1 * 0.4
  }

  func testResetClearsEverything() {
    let keeper = ScoreKeeper()
    for _ in 0..<50 { keeper.sample(expected: true, level: 0.5) }
    XCTAssertNotNil(keeper.result())
    keeper.reset()
    XCTAssertNil(keeper.result())
  }
}

final class RoomVoiceTests: XCTestCase {
  /// The failure this whole type exists to prevent: nobody in the room, stereo
  /// on, lyrics rolling. A plain level gate hands that a perfect score.
  func testAnEmptyRoomWithTheStereoOnScoresNothing() {
    let voice = RoomVoice()
    let keeper = ScoreKeeper()
    let music = 0.3

    // Every song opens on something before the first word.
    for _ in 0..<20 { _ = voice.voiceLevel(level: music, expected: false) }
    for frame in 0..<200 {
      let expected = frame % 10 < 8 // lines, with gaps between them
      let level = voice.voiceLevel(level: music, expected: expected)
      keeper.sample(expected: expected, level: level)
    }

    XCTAssertEqual(keeper.result()?.score, 0)
    XCTAssertEqual(keeper.result()?.grade, "Keep going")
  }

  func testASingerOverTheSameMusicScores() {
    let voice = RoomVoice()
    let keeper = ScoreKeeper()
    let music = 0.3
    let singing = (music * music + 0.08 * 0.08).squareRoot() // powers add, not amplitudes

    for _ in 0..<20 { _ = voice.voiceLevel(level: music, expected: false) }
    for frame in 0..<200 {
      let expected = frame % 10 < 8
      let level = voice.voiceLevel(level: expected ? singing : music, expected: expected)
      keeper.sample(expected: expected, level: level)
    }

    XCTAssertEqual(keeper.result()?.score, 100)
  }

  func testItRecoversTheSingersOwnLevel() {
    let voice = RoomVoice()
    for _ in 0..<50 { _ = voice.voiceLevel(level: 0.3, expected: false) }
    XCTAssertEqual(voice.baseline, 0.3, accuracy: 1e-9)

    let room = (0.3 * 0.3 + 0.08 * 0.08).squareRoot()
    XCTAssertEqual(voice.voiceLevel(level: room, expected: true), 0.08, accuracy: 1e-9)
  }

  func testQuieterThanTheMusicIsNotNegativeVoice() {
    let voice = RoomVoice()
    for _ in 0..<50 { _ = voice.voiceLevel(level: 0.3, expected: false) }
    // The track dipped. There is no such thing as less than no singing.
    XCTAssertEqual(voice.voiceLevel(level: 0.1, expected: true), 0)
  }

  func testASongThatOpensOnAVocalStillScores() {
    let voice = RoomVoice()
    // No music-only frame has ever been seen, so the raw level is the best
    // guess available — better than scoring an a cappella opening as silence.
    XCTAssertEqual(voice.voiceLevel(level: 0.2, expected: true), 0.2)
  }

  func testSilenceAndGarbageDoNotPoisonTheBaseline() {
    let voice = RoomVoice()
    XCTAssertEqual(voice.voiceLevel(level: .nan, expected: true), 0)
    XCTAssertEqual(voice.voiceLevel(level: -1, expected: false), 0)
    XCTAssertEqual(voice.baseline, 0)
    XCTAssertTrue(voice.baseline.isFinite)
  }

  func testResetForgetsTheRoom() {
    let voice = RoomVoice()
    for _ in 0..<50 { _ = voice.voiceLevel(level: 0.3, expected: false) }
    voice.reset()
    XCTAssertEqual(voice.baseline, 0)
    XCTAssertEqual(voice.voiceLevel(level: 0.2, expected: true), 0.2, "unseeded again")
  }
}
