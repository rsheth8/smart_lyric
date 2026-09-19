import XCTest
@testable import Bar4BarCore

// Pure-math tests for all sprint-2 features. No UI, no MainActor — runs under
// `swift test --package-path tvos/Bar4BarCore`.

// MARK: - Instrumental countdown alpha formulas
// These mirror the exact expressions in PhraseStage.instrumentalCountdown.

final class InstrumentalCountdownTests: XCTestCase {

  // artworkAlpha = min(1.0, max(0, (eta - 4) / 6.0))
  func testArtworkAlphaIsZeroWhenEtaAtOrBelow4() {
    XCTAssertEqual(artworkAlpha(eta: 0), 0, accuracy: 0.001)
    XCTAssertEqual(artworkAlpha(eta: 2), 0, accuracy: 0.001)
    XCTAssertEqual(artworkAlpha(eta: 4), 0, accuracy: 0.001)
  }

  func testArtworkAlphaRampsBetween4And10() {
    XCTAssertEqual(artworkAlpha(eta: 7), 0.5, accuracy: 0.001)
    XCTAssertEqual(artworkAlpha(eta: 10), 1.0, accuracy: 0.001)
  }

  func testArtworkAlphaClampsAt1Above10() {
    XCTAssertEqual(artworkAlpha(eta: 15), 1.0, accuracy: 0.001)
    XCTAssertEqual(artworkAlpha(eta: 60), 1.0, accuracy: 0.001)
  }

  // labelAlpha = max(0, min(1, (eta - 10) / 4))
  func testSectionLabelHiddenBelow10() {
    XCTAssertEqual(labelAlpha(eta: 0), 0, accuracy: 0.001)
    XCTAssertEqual(labelAlpha(eta: 8), 0, accuracy: 0.001)
    XCTAssertEqual(labelAlpha(eta: 10), 0, accuracy: 0.001)
  }

  func testSectionLabelRampsBetween10And14() {
    XCTAssertEqual(labelAlpha(eta: 12), 0.5, accuracy: 0.001)
    XCTAssertEqual(labelAlpha(eta: 14), 1.0, accuracy: 0.001)
  }

  func testSectionLabelClampedAt1Beyond14() {
    XCTAssertEqual(labelAlpha(eta: 30), 1.0, accuracy: 0.001)
  }

  // countAlpha: showCount = eta < 8 && eta > 0.2; alpha = min(1, (8-eta)/2)
  func testCountAlphaZeroOutsideWindow() {
    XCTAssertEqual(countAlpha(eta: 10), 0, accuracy: 0.001)
    XCTAssertEqual(countAlpha(eta: 8), 0, accuracy: 0.001)   // not < 8
    XCTAssertEqual(countAlpha(eta: 0.1), 0, accuracy: 0.001) // not > 0.2
  }

  func testCountAlphaFullBelow6() {
    XCTAssertEqual(countAlpha(eta: 6), 1.0, accuracy: 0.001)
    XCTAssertEqual(countAlpha(eta: 4), 1.0, accuracy: 0.001)
  }

  func testCountAlphaRampsBetween6And8() {
    XCTAssertEqual(countAlpha(eta: 7), 0.5, accuracy: 0.001)
  }

  // countText: ceil(eta) seconds label or "GET READY"
  func testCountTextIsGetReadyBelow1Point2() {
    XCTAssertEqual(countText(eta: 1.0), "GET READY")
    XCTAssertEqual(countText(eta: 0.5), "GET READY")
  }

  func testCountTextShowsCeiledSeconds() {
    XCTAssertEqual(countText(eta: 3.0), "BACK IN 3s")
    XCTAssertEqual(countText(eta: 7.5), "BACK IN 8s") // ceil(7.5) = 8
    XCTAssertEqual(countText(eta: 7.0), "BACK IN 7s")
  }

  // Helpers — exact copies of the formulas in PhraseStage.instrumentalCountdown
  private func artworkAlpha(eta: Double) -> Double { min(1.0, max(0, (eta - 4) / 6.0)) }
  private func labelAlpha(eta: Double) -> Double { max(0.0, min(1.0, (eta - 10.0) / 4.0)) }
  private func countAlpha(eta: Double) -> Double {
    let show = eta < 8 && eta > 0.2
    return show ? min(1.0, (8.0 - eta) / 2.0) : 0.0
  }
  private func countText(eta: Double) -> String {
    eta > 1.2 ? "BACK IN \(Int(ceil(eta)))s" : "GET READY"
  }
}

// MARK: - Party mode YOUR TURN flash alpha

final class PartyFlashAlphaTests: XCTestCase {

  // alpha = min(1, age/0.15) * max(0, 1 - max(0, age-0.5) / 1.0)
  // guard age < 1.5 else return 0

  func testFlashIsZeroAtAge0() {
    XCTAssertEqual(flipAlpha(age: 0), 0, accuracy: 0.001)
  }

  func testFlashRisesTo1At0Point15() {
    XCTAssertEqual(flipAlpha(age: 0.15), 1.0, accuracy: 0.001)
  }

  func testFlashIsMidwayAt0Point075() {
    XCTAssertEqual(flipAlpha(age: 0.075), 0.5, accuracy: 0.001)
  }

  func testFlashStaysAt1Between0Point15And0Point5() {
    XCTAssertEqual(flipAlpha(age: 0.30), 1.0, accuracy: 0.001)
    XCTAssertEqual(flipAlpha(age: 0.50), 1.0, accuracy: 0.001)
  }

  func testFlashDecaysAfter0Point5() {
    XCTAssertEqual(flipAlpha(age: 1.0), 0.5, accuracy: 0.001)
  }

  func testFlashIsZeroAtAndAfter1Point5() {
    XCTAssertEqual(flipAlpha(age: 1.5), 0, accuracy: 0.001)
    XCTAssertEqual(flipAlpha(age: 2.0), 0, accuracy: 0.001)
  }

  private func flipAlpha(age: Double) -> Double {
    guard age < 1.5 else { return 0 }
    return min(1.0, age / 0.15) * max(0.0, 1.0 - max(0, age - 0.5) / 1.0)
  }
}

// MARK: - Section label fade-in / fade-out alpha

final class SectionLabelAlphaTests: XCTestCase {

  // alpha = min(1, age/0.25) * max(0, 1 - max(0, age-1.5)/1.5)
  // guard age < 3 else return 0

  func testLabelIsZeroAtAge0() {
    XCTAssertEqual(labelAlpha(age: 0), 0, accuracy: 0.001)
  }

  func testLabelReachesFullAt0Point25() {
    XCTAssertEqual(labelAlpha(age: 0.25), 1.0, accuracy: 0.001)
  }

  func testLabelStaysFullBetween0Point25And1Point5() {
    XCTAssertEqual(labelAlpha(age: 1.0), 1.0, accuracy: 0.001)
    XCTAssertEqual(labelAlpha(age: 1.5), 1.0, accuracy: 0.001)
  }

  func testLabelHalfwayAt2Point25() {
    XCTAssertEqual(labelAlpha(age: 2.25), 0.5, accuracy: 0.001)
  }

  func testLabelIsZeroAt3() {
    XCTAssertEqual(labelAlpha(age: 3.0), 0, accuracy: 0.001)
    XCTAssertEqual(labelAlpha(age: 5.0), 0, accuracy: 0.001)
  }

  private func labelAlpha(age: Double) -> Double {
    guard age < 3.0 else { return 0 }
    return min(1.0, age / 0.25) * max(0.0, 1.0 - max(0, age - 1.5) / 1.5)
  }
}

// MARK: - Blank-a-word hidden word set computation

final class BlankWordSetTests: XCTestCase {

  func testBlankOffProducesEmptySet() {
    XCTAssertTrue(hiddenWords(n: 0, count: 6).isEmpty)
    XCTAssertTrue(hiddenWords(n: 1, count: 6).isEmpty) // 1 also treated as off (off is 0, first valid is 2)
  }

  func testEvery2ndWordOnSixWordLine() {
    XCTAssertEqual(hiddenWords(n: 2, count: 6), [1, 3, 5])
  }

  func testEvery3rdWordOnSixWordLine() {
    XCTAssertEqual(hiddenWords(n: 3, count: 6), [2, 5])
  }

  func testEvery4thWordOnEightWordLine() {
    XCTAssertEqual(hiddenWords(n: 4, count: 8), [3, 7])
  }

  func testFirstWordIsNeverHiddenForAnyN() {
    for n in [2, 3, 4] {
      XCTAssertFalse(hiddenWords(n: n, count: 10).contains(0),
                     "First word must never be blanked for N=\(n)")
    }
  }

  func testSingleWordLineIsNeverBlanked() {
    XCTAssertTrue(hiddenWords(n: 2, count: 1).isEmpty)
  }

  func testEvery2ndOnOddLine() {
    // 5-word line: indices 1, 3 are hidden (not 5 — doesn't exist)
    XCTAssertEqual(hiddenWords(n: 2, count: 5), [1, 3])
  }

  // Mirror of the exact formula in PhraseStage.board()
  private func hiddenWords(n: Int, count: Int) -> Set<Int> {
    guard n > 1 else { return [] }
    return Set((0..<count).filter { ($0 + 1) % n == 0 })
  }
}

// MARK: - Loop section boundary detection

final class LoopSectionBoundaryTests: XCTestCase {

  private func sections() -> [Sections.Section] {
    [
      Sections.Section(part: .verse,  start: 0,  end: 10),
      Sections.Section(part: .chorus, start: 10, end: 20),
      Sections.Section(part: .verse,  start: 20, end: 30),
    ]
  }

  func testLoopTriggersWithin0Point1sOfSectionEnd() {
    let cue = 19.95
    XCTAssertTrue(shouldLoop(cue: cue, sections: sections()))
  }

  func testLoopTriggersExactlyAt0Point1sBeforeEnd() {
    let cue = 19.9
    XCTAssertTrue(shouldLoop(cue: cue, sections: sections()))
  }

  func testLoopDoesNotTriggerMoreThan0Point1sBeforeEnd() {
    XCTAssertFalse(shouldLoop(cue: 19.5, sections: sections()))
    XCTAssertFalse(shouldLoop(cue: 15.0, sections: sections()))
  }

  func testLoopSeeksToCorrectSectionStart() {
    let cue = 19.95
    let s = sections()
    let current = s.last(where: { $0.start <= cue })
    XCTAssertEqual(current?.start, 10, "Should seek to chorus start, not verse start")
  }

  func testLoopAtLastSectionDoesNotCrash() {
    let cue = 29.95
    let s = sections()
    let next = s.first(where: { $0.start > cue })
    XCTAssertNil(next) // No next section — loop should not fire
    XCTAssertFalse(shouldLoop(cue: cue, sections: s))
  }

  func testLoopDoesNotFireAtStart() {
    XCTAssertFalse(shouldLoop(cue: 0, sections: sections()))
    XCTAssertFalse(shouldLoop(cue: 5, sections: sections()))
  }

  // Mirror of loop check in PhraseStage body
  private func shouldLoop(cue: Double, sections: [Sections.Section]) -> Bool {
    guard let next = sections.first(where: { $0.start > cue }),
          sections.last(where: { $0.start <= cue }) != nil else { return false }
    return cue >= next.start - 0.1
  }
}

// MARK: - End-of-song line counter (Set<Int> semantics)

final class SungLineCounterTests: XCTestCase {

  func testUniqueLineCount() {
    var sung = Set<Int>()
    for line in 0..<10 { sung.insert(line) }
    XCTAssertEqual(sung.count, 10)
  }

  func testRepeatedFramesDoNotInflateCount() {
    var sung = Set<Int>()
    for _ in 0..<60 { sung.insert(3) } // 60 frames on same line
    XCTAssertEqual(sung.count, 1)
  }

  func testRepeatedChorusDoesNotDoubleCounts() {
    var sung = Set<Int>()
    let chorus = Array(4...8)
    for line in chorus { sung.insert(line) }
    for line in chorus { sung.insert(line) } // chorus repeats
    XCTAssertEqual(sung.count, 5)
  }

  func testSungFractionIsCorrect() {
    var sung = Set<Int>()
    for line in 0..<5 { sung.insert(line) }
    let fraction = Double(sung.count) / Double(20)
    XCTAssertEqual(fraction, 0.25, accuracy: 0.001)
  }

  func testEmptySungCountIsZero() {
    XCTAssertEqual(Set<Int>().count, 0)
  }
}

// MARK: - Concert visualizer gating logic

final class ConcertVisualizerGatingTests: XCTestCase {

  // hasSomethingToWatch = hasLyrics || (nowPlaying != nil && !isLoading)

  func testNoSongShowsNothing() {
    XCTAssertFalse(gate(hasLyrics: false, hasSong: false, isLoading: false))
  }

  func testLyricsAlwaysShowStage() {
    XCTAssertTrue(gate(hasLyrics: true,  hasSong: false, isLoading: false))
    XCTAssertTrue(gate(hasLyrics: true,  hasSong: true,  isLoading: true))
  }

  func testNoLyricsWithReadySongShowsConcertVisualizer() {
    XCTAssertTrue(gate(hasLyrics: false, hasSong: true, isLoading: false))
  }

  func testNoLyricsWhileStillLoadingShowsEmptyState() {
    XCTAssertFalse(gate(hasLyrics: false, hasSong: true, isLoading: true))
  }

  private func gate(hasLyrics: Bool, hasSong: Bool, isLoading: Bool) -> Bool {
    hasLyrics || (hasSong && !isLoading)
  }
}

// MARK: - Dense line badge — StageDirection.isDense integration

final class DenseBadgeTests: XCTestCase {

  private var demo: Timeline { DemoTimeline.barForBar() }

  func testKnownFastLineIsMarkedDense() {
    XCTAssertTrue(StageDirection.isDense(demo.lines[6]))
  }

  func testHeldLineIsNotDense() {
    XCTAssertFalse(StageDirection.isDense(demo.lines[4]))
  }

  func testExplicitlyFastLineIsAlwaysDense() {
    let fast = LyricLine(start: 0, end: 2, words: (0..<10).map { i in
      LyricWord(text: "word", start: Double(i) * 0.2, end: Double(i) * 0.2 + 0.18)
    })
    XCTAssertTrue(StageDirection.isDense(fast))
  }

  func testSingleWordLineIsNeverDense() {
    let single = LyricLine(start: 0, end: 4, words: [
      LyricWord(text: "Hold", start: 0, end: 4)
    ])
    XCTAssertFalse(StageDirection.isDense(single))
  }
}
