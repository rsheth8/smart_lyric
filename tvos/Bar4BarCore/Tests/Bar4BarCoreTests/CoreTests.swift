import XCTest
@testable import Bar4BarCore

final class MatchTests: XCTestCase {
  func testDurationScoreNear() {
    XCTAssertEqual(Match.durationScore(targetSec: 200, candidateSec: 201), 1)
    XCTAssertEqual(Match.durationScore(targetSec: 200, candidateSec: 202.5), 1)
  }

  func testDurationScoreFar() {
    XCTAssertEqual(Match.durationScore(targetSec: 200, candidateSec: 220), 0)
  }

  func testPreferSkipsMismatch() {
    let wrong = LyricsResult(
      timeline: Timeline(lines: [LyricLine(start: 0, end: 1, words: [])], source: "yrc"),
      meta: LyricsMeta(duration: 400),
      richness: 0
    )
    let right = LyricsResult(
      timeline: Timeline(lines: [LyricLine(start: 0, end: 1, words: [])], source: "lrc"),
      meta: LyricsMeta(duration: 200),
      richness: 1
    )
    let pick = Match.preferResult([wrong, right], targetDuration: 200)
    XCTAssertEqual(pick?.meta.duration, 200)
  }
}

final class DisplayMathTests: XCTestCase {
  func testWipeProgress() {
    XCTAssertEqual(DisplayMath.wipeProgress(t: 0.5, start: 1, end: 2), 0)
    XCTAssertEqual(DisplayMath.wipeProgress(t: 1, start: 1, end: 2), 0)
    XCTAssertEqual(DisplayMath.wipeProgress(t: 1.5, start: 1, end: 2), 0.5)
    XCTAssertEqual(DisplayMath.wipeProgress(t: 2, start: 1, end: 2), 1)
  }

  func testResolveActiveLine() {
    let lines = [
      LyricLine(start: 0, end: 2, words: []),
      LyricLine(start: 3, end: 5, words: []),
    ]
    XCTAssertEqual(DisplayMath.resolveActiveLine(lines, t: 1), 0)
    XCTAssertEqual(DisplayMath.resolveActiveLine(lines, t: 3.5), 1)
    XCTAssertEqual(DisplayMath.resolveActiveLine(lines, t: 2.5, prevLi: 0, vocalActive: false), 0)
  }
}

final class FormatTests: XCTestCase {
  func testParseLRC() {
    let sample = """
    [00:12.00]Hello world
    [00:16.00]Second line
    """
    let tl = LRC.parse(sample)
    XCTAssertEqual(tl.lines.count, 2)
    XCTAssertEqual(tl.lines[0].words.map(\.text), ["Hello", "world"])
    XCTAssertEqual(tl.lines[0].start, 12, accuracy: 0.001)
  }

  func testParseYRCFixture() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "adele-someone", withExtension: "yrc", subdirectory: "Fixtures"))
    let raw = try String(contentsOf: url, encoding: .utf8)
    let tl = YRC.parse(raw)
    XCTAssertGreaterThan(tl.lines.count, 10)
    XCTAssertEqual(tl.lines[0].words.first?.text, "I")
    XCTAssertEqual(tl.source, "yrc")
  }

  func testParseRichsync() {
    let body = """
    [{"ts":1.0,"te":3.0,"x":"hi there","l":[{"c":"hi","o":0},{"c":" ","o":0.4},{"c":"there","o":0.5}]}]
    """
    let tl = Richsync.parse(body)
    XCTAssertEqual(tl.lines.count, 1)
    XCTAssertEqual(tl.lines[0].words.map(\.text), ["hi", "there"])
  }

  func testTTMLClock() {
    XCTAssertEqual(TTML.parseClock("12.5"), 12.5)
    XCTAssertEqual(TTML.parseClock("01:02.5")!, 62.5, accuracy: 0.001)
  }

  func testStreamingClockExactPosition() {
    var playing = true
    var pos = 10.0
    let clock = StreamingClock(isPlaying: { playing }, getPosition: { pos })
    XCTAssertEqual(clock.now(), 10)
    pos = 12.5
    XCTAssertEqual(clock.now(), 12.5)
    playing = false
    XCTAssertFalse(clock.isPlaying())
  }
}
