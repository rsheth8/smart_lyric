import XCTest
@testable import Bar4BarCore

final class MatchTests: XCTestCase {
  func testWordTimingWinsOverEarlierLineOnlyProvider() {
    let line = LyricsResult(timeline: Timeline(lines: [], source: "lrc"), richness: 1)
    let word = LyricsResult(timeline: Timeline(lines: [], source: "richsync"), richness: 0)
    XCTAssertEqual(Match.preferResult([line, word], targetDuration: nil)?.timeline.source, "richsync")
    XCTAssertEqual(Match.preferResult([line, word], targetDuration: 200)?.timeline.source, "richsync")
  }

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
    XCTAssertEqual(DisplayMath.singerLeadListen, 0)
    XCTAssertEqual(DisplayMath.singerLead, 0.12)
    XCTAssertEqual(PerformanceMode.from(lead: 0), .listen)
    XCTAssertEqual(PerformanceMode.from(lead: 0.12), .sing)
    XCTAssertEqual(PerformanceMode.sing.toggled, .listen)
    XCTAssertEqual(DisplayMath.wordPhase(t: 0.8, start: 1, end: 2, leadin: 0.32), .leadin)
    XCTAssertEqual(DisplayMath.wordPhase(t: 0.8, start: 1, end: 2, leadin: 0), .upcoming)
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

  func testIntroRunwayStartsEmptyAndFillsTheRealWait() {
    let lines = [
      LyricLine(start: 0.8, end: 4, words: [LyricWord(text: "x", start: 0.8, end: 4)]),
    ]
    XCTAssertEqual(DisplayMath.runwayProgress(lines: lines, t: 0, activeLi: -1, instrumental: false, countIn: nil)!, 0, accuracy: 0.001)
    XCTAssertEqual(DisplayMath.runwayProgress(lines: lines, t: 0.4, activeLi: -1, instrumental: false, countIn: nil)!, 0.5, accuracy: 0.001)
    XCTAssertNil(DisplayMath.runwayProgress(lines: lines, t: 0.8, activeLi: -1, instrumental: false, countIn: nil))
  }

  func testInstrumentalRunwayFillsTheWholeGap() {
    let lines = [
      LyricLine(start: 0, end: 4, words: [LyricWord(text: "a", start: 0, end: 4)]),
      LyricLine(start: 12, end: 16, words: [LyricWord(text: "b", start: 12, end: 16)]),
    ]
    XCTAssertNil(DisplayMath.runwayProgress(lines: lines, t: 2, activeLi: 0, instrumental: false, countIn: nil))
    XCTAssertEqual(DisplayMath.runwayProgress(lines: lines, t: 8, activeLi: 0, instrumental: true, countIn: nil)!, 0.5, accuracy: 0.001)
    XCTAssertNil(DisplayMath.runwayProgress(lines: lines, t: 12, activeLi: 0, instrumental: true, countIn: nil))
  }

  func testRunwayDoesNotAppearOnAShortBreath() {
    let lines = [
      LyricLine(start: 0, end: 4, words: [LyricWord(text: "a", start: 0, end: 4)]),
      LyricLine(start: 4.4, end: 6, words: [LyricWord(text: "b", start: 4.4, end: 6)]),
    ]
    XCTAssertNil(DisplayMath.runwayProgress(lines: lines, t: 4.2, activeLi: 0, instrumental: false, countIn: nil))
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

  func testLineEstimatesAndEnhancedLRCAreDistinguished() {
    XCTAssertFalse(LRC.parse("[00:01.00]Hello world").hasWordTiming)
    let enhanced = LRC.parse("[00:01.00]<00:01.00>Hello <00:02.00>world")
    XCTAssertTrue(enhanced.hasWordTiming)
    XCTAssertEqual(enhanced.lines[0].words[1].start, 2)
  }

  func testYRCPreservesSilenceBetweenWordsAndAtTheEnd() {
    let timeline = YRC.parse("[1000,4000](1000,500,0)Hello (3000,500,0)world")
    XCTAssertEqual(timeline.lines[0].words[0].end, 1.5)
    XCTAssertEqual(timeline.lines[0].words[1].end, 3.5)
    XCTAssertTrue(timeline.hasWordTiming)
  }

  func testParseYRCFixture() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "adele-someone", withExtension: "yrc", subdirectory: "Fixtures"))
    let raw = try String(contentsOf: url, encoding: .utf8)
    let tl = YRC.parse(raw)
    XCTAssertGreaterThan(tl.lines.count, 10)
    XCTAssertEqual(tl.lines[0].words.first?.text, "I")
    XCTAssertEqual(tl.source, "yrc")
  }

  func testRichsyncDoesNotRedistributeRealOffsets() {
    let body = #"[{"ts":1,"te":4,"l":[{"c":"hi","o":0},{"c":"there","o":0.2}]},{"ts":10,"te":12,"l":[{"c":"next","o":0}]}]"#
    let timeline = Richsync.parse(body)
    XCTAssertEqual(timeline.lines[0].words[1].start, 1.2, accuracy: 0.001)
    XCTAssertEqual(timeline.lines[0].words[1].end, 4)
    XCTAssertEqual(timeline.lines[0].end, 4)
    XCTAssertTrue(timeline.hasWordTiming)
    XCTAssertFalse(Richsync.parse(#"[{"ts":1,"te":4,"x":"Only a line"}]"#).hasWordTiming)
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
