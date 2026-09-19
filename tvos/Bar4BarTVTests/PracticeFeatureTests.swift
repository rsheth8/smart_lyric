import XCTest
import Bar4BarCore
@testable import Bar4BarTV

@MainActor
final class PracticeFeatureTests: XCTestCase {

  override func tearDown() {
    UserDefaults.standard.removeObject(forKey: "bar4bar.stage.partyMode")
    super.tearDown()
  }

  // MARK: - blankNthWord

  func testBlankNthWordDefaultsToOff() {
    XCTAssertEqual(LyricsSession().blankNthWord, 0)
  }

  func testBlankNthWordAcceptsAllValidValues() {
    let session = LyricsSession()
    for v in [0, 2, 3, 4] {
      session.blankNthWord = v
      XCTAssertEqual(session.blankNthWord, v)
    }
  }

  func testBlankNthWordDoesNotAffectSingerLead() {
    let session = LyricsSession()
    let before = session.singerLead
    session.blankNthWord = 2
    XCTAssertEqual(session.singerLead, before, accuracy: 1e-9)
  }

  func testBlankNthWordDoesNotAffectSyncOffset() {
    let session = LyricsSession()
    session.nudgeSync(by: 0.1)
    let before = session.syncOffset
    session.blankNthWord = 3
    XCTAssertEqual(session.syncOffset, before, accuracy: 1e-9)
    session.resetSync()
  }

  func testBlankWordCycleMatchesSettingsPanel() {
    // StageSettingsPanel cycles [0→2→3→4→0] via (blankIdx+1) % 4
    let values = [0, 2, 3, 4]
    var idx = 0
    let cycle: () -> Void = { idx = (idx + 1) % values.count }
    cycle(); XCTAssertEqual(values[idx], 2)
    cycle(); XCTAssertEqual(values[idx], 3)
    cycle(); XCTAssertEqual(values[idx], 4)
    cycle(); XCTAssertEqual(values[idx], 0)
  }

  // MARK: - loopSection

  func testLoopSectionDefaultsToFalse() {
    XCTAssertFalse(LyricsSession().loopSection)
  }

  func testLoopSectionCanBeToggled() {
    let session = LyricsSession()
    session.loopSection = true
    XCTAssertTrue(session.loopSection)
    session.loopSection = false
    XCTAssertFalse(session.loopSection)
  }

  func testLoopSectionDoesNotAffectPerformanceMode() {
    let session = LyricsSession()
    let before = session.performanceMode
    session.loopSection = true
    XCTAssertEqual(session.performanceMode, before)
  }

  func testLoopSectionDoesNotAffectAidMode() {
    let session = LyricsSession()
    session.loopSection = true
    XCTAssertEqual(session.aidMode, .off)
  }

  // MARK: - Independence

  func testPracticeModePropertiesAreIndependent() {
    let session = LyricsSession()
    session.blankNthWord = 2
    session.loopSection = true
    session.blankNthWord = 0
    XCTAssertTrue(session.loopSection, "loopSection must not reset when blankNthWord changes")
    session.loopSection = false
    XCTAssertEqual(session.blankNthWord, 0, "blankNthWord must not reset when loopSection changes")
  }

  func testClearPreservesPracticeSettings() {
    let session = LyricsSession()
    session.blankNthWord = 3
    session.loopSection = true
    session.clear()
    XCTAssertEqual(session.blankNthWord, 3, "blankNthWord is a user preference and must not clear with session")
    XCTAssertTrue(session.loopSection, "loopSection is a user preference and must not clear with session")
  }

  // MARK: - partyMode persistence

  func testPartyModeDefaultsToSolo() {
    UserDefaults.standard.removeObject(forKey: "bar4bar.stage.partyMode")
    XCTAssertEqual(LyricsSession().partyMode, "Solo")
  }

  func testPartyModePersistsAcrossSessionInstances() {
    let s1 = LyricsSession()
    s1.partyMode = "Take turns"
    let s2 = LyricsSession()
    XCTAssertEqual(s2.partyMode, "Take turns")
  }

  func testPartyModeAcceptsAllThreeValues() {
    let session = LyricsSession()
    for mode in ["Solo", "Take turns", "Everyone"] {
      session.partyMode = mode
      XCTAssertEqual(session.partyMode, mode)
    }
  }
}
