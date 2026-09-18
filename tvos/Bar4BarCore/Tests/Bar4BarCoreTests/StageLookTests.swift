import XCTest
@testable import Bar4BarCore

final class StageLookTests: XCTestCase {

  private func line(_ start: Double, _ end: Double, text: String = "hello world this line") -> LyricLine {
    LyricLine(
      start: start,
      end: end,
      words: [LyricWord(text: text, start: start, end: end)]
    )
  }

  // MARK: - Resolve

  func testVerseIsDocument() {
    let look = StageLookMath.resolve(
      part: .verse,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 8),
      inLongGap: false,
      reduceMotion: false
    )
    XCTAssertEqual(look, .document)
  }

  func testChorusIsAnthem() {
    let look = StageLookMath.resolve(
      part: .chorus,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 2),
      inLongGap: false,
      reduceMotion: false
    )
    XCTAssertEqual(look, .anthem)
  }

  func testUnknownStructureStaysDocument() {
    let look = StageLookMath.resolve(
      part: nil,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 1),
      inLongGap: false,
      reduceMotion: false
    )
    XCTAssertEqual(look, .document)
  }

  func testInstrumentalIsPicture() {
    let look = StageLookMath.resolve(
      part: .verse,
      gap: DisplayMath.GapState(instrumental: true, nextVocalIn: 4),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(look, .picture)
  }

  func testAuthoredIntroIsPicture() {
    let look = StageLookMath.resolve(
      part: .intro,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 7),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(look, .picture)
  }

  func testLastBeatOfALongGapIsBreath() {
    let look = StageLookMath.resolve(
      part: .verse,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 0.2),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(look, .breath)
  }

  func testBreathYieldsToPictureWhenReduceMotion() {
    let look = StageLookMath.resolve(
      part: .verse,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 0.2),
      inLongGap: true,
      reduceMotion: true
    )
    XCTAssertEqual(look, .picture)
  }

  func testShortBreathBetweenLinesIsNotACameraCut() {
    let look = StageLookMath.resolve(
      part: .chorus,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 0.2),
      inLongGap: false,
      reduceMotion: false
    )
    XCTAssertEqual(look, .anthem)
  }

  func testChorusHoldsThroughTheEnterDelayThenCutsToPicture() {
    // First 0.9 s after a chorus line: long gap but ♪ has not entered yet.
    let hold = StageLookMath.resolve(
      part: .chorus,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 4.2),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(hold, .anthem)

    let cut = StageLookMath.resolve(
      part: .chorus,
      gap: DisplayMath.GapState(instrumental: true, nextVocalIn: 3.0),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(cut, .picture)
  }

  func testExitLeadBeforeBreathStaysPicture() {
    let look = StageLookMath.resolve(
      part: .verse,
      gap: DisplayMath.GapState(instrumental: false, nextVocalIn: 0.45),
      inLongGap: true,
      reduceMotion: false
    )
    XCTAssertEqual(look, .picture)
  }

  // MARK: - inLongGap

  func testLongGapBetweenLines() {
    let lines = [line(0, 4), line(12, 16)]
    XCTAssertFalse(StageLookMath.inLongGap(lines: lines, t: 2, activeLi: 0))
    XCTAssertTrue(StageLookMath.inLongGap(lines: lines, t: 5, activeLi: 0))
    XCTAssertFalse(StageLookMath.inLongGap(lines: lines, t: 13, activeLi: 1))
  }

  func testShortGapIsNotLong() {
    let lines = [line(0, 4), line(4.4, 6)]
    XCTAssertFalse(StageLookMath.inLongGap(lines: lines, t: 4.2, activeLi: 0))
  }

  func testIntroWaitIsLongOnlyWhenTheFirstLineIsFar() {
    let close = [line(0.8, 4)]
    XCTAssertFalse(StageLookMath.inLongGap(lines: close, t: 0.2, activeLi: -1))
    let far = [line(8, 12)]
    XCTAssertTrue(StageLookMath.inLongGap(lines: far, t: 1, activeLi: -1))
  }

  // MARK: - Demo reel

  func testDemoOpeningHookIsAnthem() {
    let tl = DemoTimeline.barForBar()
    let sections = Sections.derive(tl)
    let look = StageLookMath.resolve(lines: tl.lines, t: 3.0, sections: sections)
    XCTAssertEqual(look, .anthem)
  }

  func testDemoInstrumentalIsPicture() {
    let tl = DemoTimeline.barForBar()
    let sections = Sections.derive(tl)
    let look = StageLookMath.resolve(lines: tl.lines, t: 10.5, sections: sections)
    XCTAssertEqual(look, .picture)
  }

  func testDemoHoldStaysOnTheSungCamera() {
    let tl = DemoTimeline.barForBar()
    let sections = Sections.derive(tl)
    let look = StageLookMath.resolve(lines: tl.lines, t: 23.5, sections: sections)
    XCTAssertNotEqual(look, .picture)
    XCTAssertNotEqual(look, .breath)
  }

  // MARK: - Grade

  func testAnthemLightIsBrighterAndWiderThanDocument() {
    XCTAssertGreaterThan(StageLight.anthem.glow, StageLight.document.glow)
    XCTAssertGreaterThan(StageLight.anthem.radius, StageLight.document.radius)
    XCTAssertLessThan(StageLight.anthem.vignette, StageLight.document.vignette)
  }

  func testBreathTargetRampsWithTheWindow() {
    let start = StageLight.target(for: .breath, nextVocalIn: StageLookMath.breathWindow)
    let mid = StageLight.target(for: .breath, nextVocalIn: 0.05)
    XCTAssertEqual(start.breath, 0, accuracy: 0.001)
    XCTAssertGreaterThan(mid.breath, 0.4)
    XCTAssertGreaterThan(mid.vignette, start.vignette)
  }

  func testGradeEasesTowardTheTarget() {
    let stepped = StageLight.document.movingToward(.anthem, dt: 0.28, tau: 0.28)
    XCTAssertEqual(stepped.anthem, 1 - exp(-1), accuracy: 0.02)
    XCTAssertGreaterThan(stepped.glow, StageLight.document.glow)
    XCTAssertLessThan(stepped.glow, StageLight.anthem.glow)
  }
}
