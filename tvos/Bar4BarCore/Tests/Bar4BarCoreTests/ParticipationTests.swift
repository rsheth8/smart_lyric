import XCTest
@testable import Bar4BarCore

final class ParticipationTests: XCTestCase {
  private func line(_ text: String, at time: Double) -> LyricLine {
    LyricLine(start: time, end: time + 2, words: text.isEmpty ? [] : [LyricWord(text: text, start: time, end: time + 2)])
  }

  func testDuoAlternatesOnlySingablePhrasesAndSurvivesTimingChanges() {
    let original = Timeline(lines: [line("First", at: 1), line("", at: 4),
      line("Second", at: 8), line("Third", at: 12)], duration: 15)
    XCTAssertEqual(Participation.side(at: 0, in: original), .a)
    XCTAssertNil(Participation.side(at: 1, in: original))
    XCTAssertEqual(Participation.nextSingableLine(after: 0, in: original), 2)
    XCTAssertEqual(Participation.side(at: 2, in: original), .b)
    XCTAssertEqual(Participation.side(at: 3, in: original), .a)
    XCTAssertNil(Participation.nextSingableLine(after: 3, in: original))

    var corrected = original
    corrected.lines[2].start = 8.4
    corrected.lines[2].words[0].start = 8.4
    XCTAssertEqual(Participation.side(at: 2, in: corrected), .b)
  }

  func testUnknownSavedModeFallsBackToSolo() {
    XCTAssertEqual(ParticipationMode(savedValue: "Take turns"), .duo)
    XCTAssertEqual(ParticipationMode(savedValue: "Everyone"), .everyone)
    XCTAssertEqual(ParticipationMode(savedValue: "unknown"), .solo)
  }
}
