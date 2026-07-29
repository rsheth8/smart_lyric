import XCTest
@testable import Bar4BarCore

final class SectionsTests: XCTestCase {

  /// One line, evenly spread words, ending where you say it does.
  private func line(_ text: String, from: Double, to: Double) -> LyricLine {
    let parts = text.split(separator: " ").map(String.init)
    let step = (to - from) / Double(max(parts.count, 1))
    let words = parts.enumerated().map { i, w in
      LyricWord(text: w, start: from + step * Double(i), end: from + step * Double(i + 1))
    }
    return LyricLine(start: from, end: to, words: words)
  }

  /// Verse / chorus / verse / chorus with an 12 s solo before the last chorus.
  private func song() -> Timeline {
    var lines: [LyricLine] = []
    // Intro: first vocal at 8 s.
    var t = 8.0
    for i in 0..<4 {
      lines.append(line("walking out the door number \(i)", from: t, to: t + 4)); t += 4.5
    }
    for _ in 0..<3 {
      lines.append(line("hold the line and let it go", from: t, to: t + 4)); t += 4.5
    }
    for i in 0..<4 {
      lines.append(line("counting all the streetlights again \(i)", from: t, to: t + 4)); t += 4.5
    }
    t += 12  // guitar solo
    for _ in 0..<3 {
      lines.append(line("hold the line and let it go", from: t, to: t + 4)); t += 4.5
    }
    return Timeline(lines: lines, duration: t + 10)
  }

  // MARK: - Chorus detection

  func testRepeatedBlockIsTheChorus() {
    let tl = song()
    let flags = Sections.chorusFlags(tl.lines)
    // The repeated "hold the line" lines, and only those.
    let chorusTexts = zip(tl.lines, flags).filter(\.1).map { Sections.lineKey($0.0) }
    XCTAssertFalse(chorusTexts.isEmpty)
    XCTAssertTrue(chorusTexts.allSatisfy { $0 == "hold the line and let it go" })
  }

  /// A line that recurs on its own is a refrain inside a verse. Labelling it a
  /// chorus would chop the rail into one-line slivers.
  func testAnIsolatedRepeatedLineIsNotAChorus() {
    let lines = [
      line("the same words again here", from: 0, to: 4),
      line("something entirely different now", from: 5, to: 9),
      line("the same words again here", from: 10, to: 14),
      line("another unrelated thought here", from: 15, to: 19),
    ]
    XCTAssertEqual(Sections.chorusFlags(lines), [false, false, false, false])
  }

  /// "oh oh oh" recurs in every song ever written.
  func testShortRepeatsDoNotCount() {
    let lines = (0..<6).map { line("oh yeah", from: Double($0) * 5, to: Double($0) * 5 + 3) }
    XCTAssertEqual(Sections.chorusFlags(lines), [Bool](repeating: false, count: 6))
  }

  func testNormalizeIgnoresCasePunctuationAndAccents() {
    XCTAssertEqual(Sections.normalize("Don't — STOP, me… now"), "don t stop me now")
    XCTAssertEqual(Sections.normalize("Café"), "cafe")
  }

  // MARK: - Derivation

  func testDerivesIntroVersesChorusesAndABreak() {
    let sections = Sections.derive(song())
    let parts = sections.map(\.part)
    XCTAssertEqual(parts.first, .intro)
    XCTAssertTrue(parts.contains(.verse))
    XCTAssertTrue(parts.contains(.chorus))
    XCTAssertTrue(parts.contains(.brk), "the 12 s solo should become its own Break")
    XCTAssertEqual(parts.last, .outro)
  }

  /// The rail is drawn end to end; a hole in it reads as a rendering bug, and
  /// the section label blanks every time the playhead crosses one.
  func testSectionsAreContiguousAndOrdered() {
    let sections = Sections.derive(song())
    XCTAssertGreaterThan(sections.count, 2)
    for (a, b) in zip(sections, sections.dropFirst()) {
      XCTAssertEqual(a.end, b.start, accuracy: 0.011, "gap between \(a.part) and \(b.part)")
      XCTAssertLessThan(a.start, a.end)
    }
  }

  func testNoSliversSurvive() {
    for section in Sections.derive(song()) {
      XCTAssertGreaterThanOrEqual(
        section.duration, 1.0,
        "\(section.part) is \(section.duration)s — too short to be actionable"
      )
    }
  }

  /// Below four lines there is no structure worth claiming to have found.
  func testTooShortToHaveStructure() {
    let tl = Timeline(lines: [line("one two three", from: 0, to: 3)], duration: 30)
    XCTAssertTrue(Sections.derive(tl).isEmpty)
  }

  /// A song with no repetition is one undifferentiated block. Showing a rail
  /// with a single segment claims an insight we do not have.
  func testUniformSongYieldsNoRail() {
    var lines: [LyricLine] = []
    for i in 0..<10 {
      lines.append(line("unique line number \(i) here", from: Double(i) * 5, to: Double(i) * 5 + 4))
    }
    XCTAssertTrue(Sections.derive(Timeline(lines: lines, duration: 60)).isEmpty)
  }

  func testInstrumentalPartsAreFlagged() {
    XCTAssertTrue(Sections.Part.intro.isInstrumental)
    XCTAssertTrue(Sections.Part.brk.isInstrumental)
    XCTAssertTrue(Sections.Part.outro.isInstrumental)
    XCTAssertFalse(Sections.Part.verse.isInstrumental)
    XCTAssertFalse(Sections.Part.chorus.isInstrumental)
  }

  // MARK: - Lookup

  func testIndexAtFindsTheContainingSection() {
    let sections = Sections.derive(song())
    let target = sections[2]
    let mid = (target.start + target.end) / 2
    XCTAssertEqual(Sections.index(in: sections, at: mid), 2)
  }

  /// The hint is the previous frame's answer, so the common case must not need
  /// the scan at all — and must still be right when it does.
  func testIndexAtIsCorrectRegardlessOfHint() {
    let sections = Sections.derive(song())
    let mid = (sections[1].start + sections[1].end) / 2
    XCTAssertEqual(Sections.index(in: sections, at: mid, hint: 1), 1)
    XCTAssertEqual(Sections.index(in: sections, at: mid, hint: 0), 1)
    XCTAssertEqual(Sections.index(in: sections, at: mid, hint: 99), 1)
  }

  func testIndexAtReturnsNilOutsideTheSong() {
    let sections = Sections.derive(song())
    XCTAssertNil(Sections.index(in: sections, at: -5))
    XCTAssertNil(Sections.index(in: sections, at: 100_000))
    XCTAssertNil(Sections.index(in: [], at: 5))
  }

  /// Catalog LRC borrows the next line's start as its end, so a boundary
  /// measured from `line.end` would swallow every gap in the song.
  func testSungUntilCapsAHeldFinalWord() {
    let held = LyricLine(
      start: 0, end: 30,
      words: [LyricWord(text: "hold", start: 0, end: 30)]
    )
    XCTAssertEqual(Sections.sungUntil(held), 2.0, accuracy: 1e-9)
  }
}
