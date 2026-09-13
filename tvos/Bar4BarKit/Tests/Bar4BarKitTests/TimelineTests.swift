import XCTest
@testable import Bar4BarKit

final class TimelineTests: XCTestCase {
  func testParseYRCHoldsWordsAndLines() {
    let yrc = """
    {"t":0,"c":[{"tx":"meta"}]}
    [1000,2000](1000,400,0)Hello (1600,500,0)world
    [5000,1000](5000,1000,0)Again
    """
    let tl = parseYRC(yrc)
    XCTAssertTrue(tl.wordSync)
    XCTAssertEqual(tl.lines.count, 2)
    XCTAssertEqual(tl.lines[0].text, "Hello world")
    // "Hello" holds until "world" starts; the line ends at its own end (before the next).
    XCTAssertEqual(tl.lines[0].words[0].end, 1.6, accuracy: 1e-9)
    XCTAssertEqual(tl.lines[0].end, 3.0, accuracy: 1e-9)
    XCTAssertEqual(tl.lines[0].words[1].end, 3.0, accuracy: 1e-9)
    // Last line trails 4s past its last word.
    XCTAssertEqual(tl.lines[1].end, 10.0, accuracy: 1e-9)
  }

  func testParseLRCSortsRepeatsAndEstimatesWords() {
    let lrc = """
    [ar:Someone]
    [00:05.00][00:01.50]Chorus line here
    [00:03.00]Verse
    [00:04.00]
    """
    let tl = parseLRC(lrc)
    XCTAssertEqual(tl.lines.map(\.start), [1.5, 3.0, 5.0])
    XCTAssertEqual(tl.lines.map(\.text), ["Chorus line here", "Verse", "Chorus line here"])
    XCTAssertEqual(tl.lines[0].end, 3.0)
    let words = tl.lines[0].words
    XCTAssertEqual(words.count, 3)
    XCTAssertEqual(words.first!.start, 1.5, accuracy: 1e-9)
    XCTAssertEqual(words.last!.end, 3.0)
    XCTAssertTrue(zip(words, words.dropFirst()).allSatisfy { $0.end == $1.start })
  }

  func testParseLRCUsesInlineWordStamps() {
    let tl = parseLRC("[00:01.00]<00:01.00>one <00:01.50>two")
    XCTAssertEqual(tl.lines[0].words.map(\.start), [1.0, 1.5])
    XCTAssertEqual(tl.lines[0].text, "one two")
  }

  func testSyllables() {
    XCTAssertEqual(syllableCount("time"), 1)
    XCTAssertEqual(syllableCount("beautiful"), 3)
    XCTAssertEqual(syllableCount("愛してる"), 4)
  }

  func testActiveLineCountInAndFinish() {
    let tl = Timeline(lines: [
      Line(start: 2, end: 4, words: [Word(text: "a", start: 2, end: 4)]),
      Line(start: 12, end: 14, words: [Word(text: "b", start: 12, end: 14)]),
    ])
    XCTAssertEqual(tl.activeLine(at: 0), -1)
    XCTAssertEqual(tl.activeLine(at: 5), 0)
    XCTAssertEqual(tl.countIn(at: 0)!, 2, accuracy: 1e-9) // intro
    XCTAssertNil(tl.countIn(at: 3)) // mid-phrase
    XCTAssertEqual(tl.countIn(at: 10)!, 2, accuracy: 1e-9) // long gap
    XCTAssertFalse(tl.isFinished(at: 19))
    XCTAssertTrue(tl.isFinished(at: 21))
  }

  func testWipeProgress() {
    XCTAssertEqual(wipeProgress(1, 2, 4), 0)
    XCTAssertEqual(wipeProgress(3, 2, 4), 0.5)
    XCTAssertEqual(wipeProgress(9, 2, 4), 1)
    XCTAssertEqual(wipeProgress(2, 2, 2), 1)
  }

  func testEstimateTimelineSpreadsLines() {
    let tl = estimateTimeline("one\n\ntwo three\n", duration: 10)
    XCTAssertEqual(tl.lines.map(\.start), [0, 5])
    XCTAssertEqual(tl.duration, 10)
  }
}
