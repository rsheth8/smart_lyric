import XCTest
@testable import Bar4BarCore

final class StageDirectionTests: XCTestCase {

  private var demo: Timeline { DemoTimeline.barForBar() }

  func testHoldOnTheDemoSustain() {
    let lines = demo.lines
    XCTAssertLessThan(StageDirection.activeHold(lines: lines, t: 21.85, activeLi: 4), 0.15)
    let held = StageDirection.activeHold(lines: lines, t: 24.0, activeLi: 4)
    XCTAssertGreaterThan(held, 0.9)
    XCTAssertEqual(StageDirection.activeHold(lines: lines, t: 1.22, activeLi: 0), 0, accuracy: 0.05)
  }

  func testWordImpactFollowsRealWordOnsets() {
    let lines = demo.lines
    XCTAssertEqual(StageDirection.wordImpact(lines: lines, t: 0.80, activeLi: 0), 1, accuracy: 0.001)
    XCTAssertGreaterThan(StageDirection.wordImpact(lines: lines, t: 0.90, activeLi: 0), 0.35)
    XCTAssertEqual(StageDirection.wordImpact(lines: lines, t: 2.10, activeLi: 0), 0, accuracy: 0.001)
    XCTAssertEqual(StageDirection.wordImpact(lines: lines, t: 1.15, activeLi: -1), 0, accuracy: 0.001)
  }

  func testOpeningChorusIsAnthemNotFinale() {
    let sections = Sections.derive(demo)
    XCTAssertFalse(StageDirection.isFinale(sections: sections, t: 3.0))
    XCTAssertTrue(StageDirection.isFinale(sections: sections, t: 36.5))
    XCTAssertFalse(StageDirection.isFinale(sections: sections, t: 23.5))
  }

  func testChorusDropOnlyFiresAtAChorusEntrance() {
    let sections = Sections.derive(demo)
    let opening = sections.first { $0.part == .chorus }!
    XCTAssertEqual(StageDirection.chorusDrop(sections: sections, t: opening.start), 1, accuracy: 0.001)
    XCTAssertGreaterThan(StageDirection.chorusDrop(sections: sections, t: opening.start + 0.5), 0.5)
    XCTAssertEqual(StageDirection.chorusDrop(sections: sections, t: opening.start + 2.0), 0, accuracy: 0.001)
    XCTAssertEqual(StageDirection.chorusDrop(sections: sections, t: 20), 0, accuracy: 0.001)
  }

  func testSingleChorusIsNotFinale() {
    let sections = [
      Sections.Section(part: .verse, start: 0, end: 8),
      Sections.Section(part: .chorus, start: 8, end: 16),
    ]
    XCTAssertFalse(StageDirection.isFinale(sections: sections, t: 10))
  }

  func testDensePatterAndNotAHeldLine() {
    XCTAssertTrue(StageDirection.isDense(demo.lines[6]))
    XCTAssertFalse(StageDirection.isDense(demo.lines[4]))
    XCTAssertFalse(StageDirection.isDense(demo.lines[1]))
  }

  func testAfterglowFreezesTheLastChorusLine() {
    XCTAssertNil(StageDirection.afterglow(lines: demo.lines, t: 40, duration: 52))
    let glow = StageDirection.afterglow(lines: demo.lines, t: 49.2, duration: 52)
    XCTAssertNotNil(glow)
    XCTAssertEqual(glow?.lineIndex, StageDirection.lastChorusLineIndex(demo.lines))
    XCTAssertEqual(glow?.freezeAt, demo.lines[glow!.lineIndex].end)
    XCTAssertNotNil(StageDirection.afterglow(lines: demo.lines, t: 51.5, duration: 52))
    XCTAssertNil(StageDirection.afterglow(lines: demo.lines, t: 52.0, duration: 52))
  }

  func testEntranceHoldsThroughALongIntroThenFades() {
    XCTAssertEqual(StageDirection.entranceOpacity(t: 1.0, firstLineStart: 12), 1, accuracy: 0.01)
    XCTAssertEqual(StageDirection.entranceOpacity(t: 12, firstLineStart: 12), 0, accuracy: 0.01)
    XCTAssertTrue(StageDirection.entranceIsFullCard(firstLineStart: 12, t: 4))
    XCTAssertFalse(StageDirection.entranceIsFullCard(firstLineStart: 0.8, t: 1))
    XCTAssertGreaterThan(StageDirection.entranceOpacity(t: 1.0, firstLineStart: 0.8), 0.2)
    XCTAssertEqual(StageDirection.entranceOpacity(t: 3.0, firstLineStart: 0.8), 0, accuracy: 0.01)
  }

  func testSkipToChorusJumpsForwardThenWraps() {
    let sections = Sections.derive(demo)
    let opening = sections.first { $0.part == .chorus }?.start
    let fromVerse = StageDirection.nextChorusStart(sections: sections, t: 15.0)
    XCTAssertNotNil(opening)
    XCTAssertNotNil(fromVerse)
    XCTAssertGreaterThan(fromVerse ?? 0, 30)
    XCTAssertEqual(StageDirection.nextChorusStart(sections: sections, t: 3.0), fromVerse)
    XCTAssertEqual(StageDirection.nextChorusStart(sections: sections, t: 46.0), opening)
  }

  func testAgainThisLineUsesTheActiveLine() {
    let lines = demo.lines
    XCTAssertEqual(StageDirection.currentLineStart(lines: lines, t: 23.5, activeLi: 4), 21.20)
    XCTAssertEqual(StageDirection.currentLineStart(lines: lines, t: 0.2, activeLi: -1), 0.80)
  }

  func testDuetLane() {
    XCTAssertEqual(StageDirection.lane(for: demo.lines[5]), .room)
    XCTAssertEqual(StageDirection.lane(for: demo.lines[0]), .none)
    XCTAssertEqual(StageDirection.Lane.lead.slug, "LEAD")
    XCTAssertEqual(StageDirection.Lane.room.slug, "ROOM")
  }
}
