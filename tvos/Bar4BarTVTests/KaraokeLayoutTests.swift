import XCTest
import UIKit
import CoreText
@testable import Bar4BarTV

final class KaraokeLayoutTests: XCTestCase {
  func testBrandedTypefaceIsBundledAndRegistered() {
    XCTAssertNotNil(UIFont(name: "Fraunces-9ptBlack", size: 86))
    XCTAssertNotNil(UIFont(name: "Fraunces-9ptBlackItalic", size: 86))
    XCTAssertNotNil(UIFont(name: "Manrope-ExtraLight", size: 108))
    XCTAssertEqual(CTFontCopyFamilyName(Tokens.typeface(108)) as String, "Manrope")
    XCTAssertEqual(CTFontCopyFamilyName(Tokens.typeface(86, editorial: true)) as String, "Fraunces")
  }

  func testFrozenFittingHandlesLongAndUnsupportedScriptPassages() {
    let short = PhraseFitting.size(words: ["Hold", "it", "here"], width: 1570, height: 320)
    let long = PhraseFitting.size(words: Array(repeating: "singalong", count: 30), width: 1570, height: 320, minSize: 64)
    let script = PhraseFitting.size(words: ["你的声音", "在这里", "一起唱歌"], width: 1570, height: 320, minSize: 52)
    XCTAssertLessThan(long, short)
    XCTAssertGreaterThanOrEqual(long, 64)  // Glass floor
    XCTAssertGreaterThanOrEqual(script, 52)
    XCTAssertGreaterThan(InstallationForms.outline("B4").bounds.width, 0)
    XCTAssertTrue(InstallationForms.outline("B4") === InstallationForms.outline("B4"))
  }

  func testLongPhraseFitIncludesRowGapsAndHeldAccentSpace() {
    let words = DemoSong.layoutFixture().lines[0].words.map(\.text)
    let bandH: CGFloat = 260  // Glass band height used by PhraseRuntime
    for width: CGFloat in [1400, 1570] {
      let size = PhraseFitting.size(words: words, width: width, height: bandH, minSize: 64)
      XCTAssertGreaterThanOrEqual(size, 64)  // Glass floor
      // When fitting succeeds above the floor, height must fit the band.
      if size > 64 {
        XCTAssertLessThanOrEqual(PhraseFitting.height(words: words, size: size, width: width), bandH)
      }
    }
  }

  func testRevealingControlsDoesNotMoveTheLyrics() {
    XCTAssertEqual(KaraokeLayout.lyricTop(chromeVisible: true), KaraokeLayout.lyricTop(chromeVisible: false))
    XCTAssertEqual(KaraokeLayout.lyricBottom(chromeVisible: true), KaraokeLayout.lyricBottom(chromeVisible: false))
    XCTAssertGreaterThan(KaraokeLayout.lyricBandHeight(chromeVisible: true), 650)
    XCTAssertEqual(KaraokeLayout.lyricBandHeight(chromeVisible: true)
      + KaraokeLayout.lyricTop(chromeVisible: true)
      + KaraokeLayout.lyricBottom(chromeVisible: true), 1080)
  }

  func testDeckStaysInsideTheTelevisionSafeArea() {
    XCTAssertGreaterThanOrEqual(KaraokeLayout.chromeBottomPad, 36)
    XCTAssertGreaterThanOrEqual(KaraokeLayout.chromeTopPad, 36)
    XCTAssertGreaterThanOrEqual(KaraokeLayout.lyricBottom(chromeVisible: true), 100)  // Glass: 120 pt for faceplate + safe area
  }

  func testLongPassagesUseReadableTypeInBothViews() {
    for immersive in [false, true] {
      let short = KaraokeLayout.typeSize(immersive: immersive, characters: 48)
      let long = KaraokeLayout.typeSize(immersive: immersive, characters: 110)
      let veryLong = KaraokeLayout.typeSize(immersive: immersive, characters: 190)
      XCTAssertLessThan(long, short)
      XCTAssertLessThan(veryLong, long)
      XCTAssertGreaterThanOrEqual(veryLong, 52)
    }
  }
}
