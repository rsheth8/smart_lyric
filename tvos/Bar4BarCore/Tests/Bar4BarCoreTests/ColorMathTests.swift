import XCTest
@testable import Bar4BarCore

final class ColorMathTests: XCTestCase {

  private func hex(_ c: RGB) -> String {
    String(
      format: "#%02X%02X%02X",
      Int((c.r * 255).rounded()),
      Int((c.g * 255).rounded()),
      Int((c.b * 255).rounded())
    )
  }

  // MARK: - Round trip

  func testOKLCHRoundTrip() {
    for value: UInt32 in [0xE3C27A, 0x5B3FA8, 0x1ED760, 0xFF715B, 0x123456] {
      let source = RGB(value)
      let back = source.oklch.rgb
      XCTAssertEqual(back.r, source.r, accuracy: 0.002, "r for \(hex(source))")
      XCTAssertEqual(back.g, source.g, accuracy: 0.002, "g for \(hex(source))")
      XCTAssertEqual(back.b, source.b, accuracy: 0.002, "b for \(hex(source))")
    }
  }

  // MARK: - Contrast

  func testContrastRatioAgainstGround() {
    // The brand gold has to clear 4.5:1 on espresso, or the whole scheme fails.
    let gold = RGB(0xE3C27A)
    XCTAssertGreaterThan(gold.contrastRatio(against: AccentMath.ground), 4.5)
  }

  func testContrastIsSymmetric() {
    let a = RGB(0xE3C27A), b = RGB(0x0B0908)
    XCTAssertEqual(a.contrastRatio(against: b), b.contrastRatio(against: a), accuracy: 1e-9)
  }

  // MARK: - Accent rebuild

  /// The point of the rule: only the hue survives. A dark, heavily saturated
  /// cover must not produce a dark, heavily saturated accent.
  func testRebuildKeepsHueAndNormalisesLightness() {
    let violet = RGB(0x5B3FA8)
    guard let built = AccentMath.rebuild(dominant: violet) else {
      return XCTFail("a saturated violet should yield an accent")
    }
    let source = violet.oklch
    let result = built.accent.oklch

    // 2.5° rather than exact: lifting a dark violet to L=0.82 can land just
    // outside sRGB, and the clamp in `fromLinear` nudges the hue a little.
    // Measured drift here is ~1°, which is imperceptible; the round-trip test
    // above is what pins the transform itself.
    XCTAssertEqual(result.h, source.h, accuracy: 2.5, "hue should carry over")
    XCTAssertEqual(result.l, AccentMath.targetL, accuracy: 0.02, "lightness is rebuilt")
    XCTAssertLessThanOrEqual(result.c, AccentMath.maxC + 0.005, "chroma is capped")
    XCTAssertGreaterThan(result.l, source.l, "the source was much darker")
  }

  func testRebuildCapsChroma() {
    // A neon source far past the brand band.
    guard let built = AccentMath.rebuild(dominant: RGB(0x00FF00)) else {
      return XCTFail("neon green should yield an accent")
    }
    XCTAssertLessThanOrEqual(built.accent.oklch.c, AccentMath.maxC + 0.005)
  }

  /// Near-greyscale art has no hue worth borrowing — the caller must fall back
  /// to the brand gold rather than tinting the UI with noise.
  /// Every accepted accent has to carry real colour, near the brand gold's own
  /// chroma. The original rule only clamped the ceiling, so a muted sleeve kept
  /// its muted chroma and rebuilt to a pale near-white — which washed the whole
  /// karaoke screen out and read as "lower quality" rather than "art-adaptive".
  func testAcceptedAccentsAreNeverWashedOut() {
    let goldChroma = RGB(0xE3C27A).oklch.c   // 0.098
    let covers: [UInt32] = [0x0FA3A3, 0xD01B2A, 0x2B4FA0, 0x6E8F3A, 0xB07020]
    for hex in covers {
      guard let built = AccentMath.rebuild(dominant: RGB(hex)) else { continue }
      let c = built.accent.oklch.c
      XCTAssertGreaterThanOrEqual(
        c, AccentMath.minC - 1e-6,
        String(format: "#%06X rebuilt at C=%.4f, below the floor", hex, c)
      )
      // Within reach of the brand's own presence, in both directions.
      XCTAssertGreaterThan(c, goldChroma * 0.7)
      XCTAssertLessThanOrEqual(c, AccentMath.maxC + 1e-6)
    }
  }

  /// A near-grey cover's hue is essentially sensor noise. Now that chroma gets
  /// lifted to the floor, letting one through would amplify that noise into a
  /// confident, wrong tint across the entire screen.
  func testNearGreyArtFallsBackRatherThanBeingAmplified() {
    for hex: UInt32 in [0x8A8078, 0x787F8A, 0x9A8A90, 0x8C8C8A] {
      XCTAssertNil(
        AccentMath.rebuild(dominant: RGB(hex)),
        String(format: "#%06X should fall back to brand gold", hex)
      )
    }
  }

  func testGreyscaleArtFallsBack() {
    XCTAssertNil(AccentMath.rebuild(dominant: RGB(0x808080)))
    XCTAssertNil(AccentMath.rebuild(dominant: RGB(0xFFFFFF)))
    XCTAssertNil(AccentMath.rebuild(dominant: RGB(0x000000)))
  }

  func testRebuiltAccentAlwaysClearsContrast() {
    // Sweep the hue circle; every accepted accent must be readable on espresso.
    for degrees in stride(from: 0.0, to: 360.0, by: 15.0) {
      let source = OKLCH(l: 0.45, c: 0.14, h: degrees).rgb
      guard let built = AccentMath.rebuild(dominant: source) else { continue }
      XCTAssertGreaterThanOrEqual(
        built.accent.contrastRatio(against: AccentMath.ground),
        AccentMath.minContrast,
        "hue \(degrees) produced an unreadable accent"
      )
    }
  }

  /// The demo's cover color is chosen so the rebuilt accent lands on the brand
  /// gold — the demo must look like Bar4Bar, while still going through the
  /// real adaptation path rather than short-circuiting it.
  func testDemoArtColorRebuildsToBrandGold() {
    guard let built = AccentMath.rebuild(dominant: RGB(0x8C6A1F)) else {
      return XCTFail("the demo cover color must yield an accent")
    }
    let gold = RGB(0xE3C27A)
    XCTAssertEqual(built.accent.r, gold.r, accuracy: 0.03)
    XCTAssertEqual(built.accent.g, gold.g, accuracy: 0.03)
    XCTAssertEqual(built.accent.b, gold.b, accuracy: 0.03)
  }

  func testSoftIsLighterThanAccent() {
    guard let built = AccentMath.rebuild(dominant: RGB(0x8C6A1F)) else {
      return XCTFail("expected an accent")
    }
    XCTAssertGreaterThan(built.soft.oklch.l, built.accent.oklch.l)
  }
}

final class GapStateTests: XCTestCase {

  private func line(_ start: Double, _ end: Double) -> LyricLine {
    LyricLine(start: start, end: end, words: [LyricWord(text: "x", start: start, end: end)])
  }

  func testNotInstrumentalWhileSinging() {
    let lines = [line(0, 4), line(12, 16)]
    let state = DisplayMath.gapState(lines: lines, t: 2, activeLi: 0)
    XCTAssertFalse(state.instrumental)
  }

  /// Sustained quiet is required — the ♪ must not appear the instant a line ends.
  func testNeedsSustainedQuietBeforeAnnouncing() {
    let lines = [line(0, 4), line(12, 16)]
    XCTAssertFalse(DisplayMath.gapState(lines: lines, t: 4.5, activeLi: 0).instrumental)
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 5.5, activeLi: 0).instrumental)
  }

  /// A short breath between phrases is not an instrumental break.
  func testShortGapIsNeverAnnounced() {
    let lines = [line(0, 4), line(6, 10)] // 2 s gap, under the 2.5 s floor
    for t in stride(from: 4.0, to: 6.0, by: 0.2) {
      XCTAssertFalse(
        DisplayMath.gapState(lines: lines, t: t, activeLi: 0).instrumental,
        "t=\(t) should not read as instrumental"
      )
    }
  }

  /// It has to clear out *before* the vocal returns, not on top of it.
  func testClearsAheadOfTheReturningVocal() {
    let lines = [line(0, 4), line(12, 16)]
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 11.4, activeLi: 0).instrumental)
    XCTAssertFalse(DisplayMath.gapState(lines: lines, t: 11.6, activeLi: 0).instrumental)
  }

  func testLongIntroCountsAsInstrumental() {
    let lines = [line(10, 14)]
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 5, activeLi: -1).instrumental)
  }

  func testReportsSecondsUntilNextVocal() {
    let lines = [line(0, 4), line(12, 16)]
    let state = DisplayMath.gapState(lines: lines, t: 7, activeLi: 0)
    XCTAssertEqual(state.nextVocalIn ?? -1, 5, accuracy: 1e-9)
  }

  /// There is no next line to count down to once the song's last line is done.
  func testNoNextVocalAtSongEnd() {
    let lines = [line(0, 4)]
    XCTAssertNil(DisplayMath.gapState(lines: lines, t: 10, activeLi: 0).nextVocalIn)
  }

  /// The outro must read as instrumental.
  ///
  /// This case previously returned `false`, which left the final line lit as
  /// the full-size hero for the whole outro — the parked highlight at its
  /// worst, because nothing ever arrives to take the spotlight off it.
  func testOutroReadsAsInstrumental() {
    let lines = [line(0, 4)]
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 10, activeLi: 0).instrumental)
  }

  /// ...but only after the same sustained quiet every other gap requires, so
  /// the last word of a song is not cut off the instant it lands.
  func testOutroStillWaitsOutTheFinalWord() {
    let lines = [line(0, 4)]
    XCTAssertFalse(DisplayMath.gapState(lines: lines, t: 4.5, activeLi: 0).instrumental)
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 5.1, activeLi: 0).instrumental)
  }

  /// An empty run-up before the first line of a one-line song is an intro, not
  /// an outro — `activeLi < 0` must not index backwards.
  func testOutroCheckDoesNotFireBeforeTheFirstLine() {
    let lines = [line(10, 14)]
    XCTAssertTrue(DisplayMath.gapState(lines: lines, t: 2, activeLi: -1).instrumental)
  }
}
