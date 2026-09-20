import XCTest

final class SprintTwoUITests: XCTestCase {

  // MARK: - Concert visualizer

  func testConcertVisualizerAppearsWhenDemoHasNoLyrics() {
    let app = XCUIApplication()
    app.launchEnvironment = [
      "BAR4BAR_AUTODEMO": "1",
      "BAR4BAR_STAGE_FIXTURE": "no-lyrics",
      "BAR4BAR_SKIP_STAGE_SETUP": "1",
      "BAR4BAR_DEMO_PAUSED": "1",
    ]
    app.launch()
    XCTAssertTrue(app.otherElements["concertVisualizer"].waitForExistence(timeout: 12))
    attachScreen(named: "sprint2-concert-visualizer")
  }

  // MARK: - Dense badge

  func testDenseBadgeAppearsOnFastLine() {
    // Demo line 6 (31.40–35.20): "Quick, quick, catch it on the up-beat now" — 8 words in 1.9s
    let app = demo(seek: "32", paused: true, clean: true)
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.otherElements["denseBadge"].exists)
    attachScreen(named: "sprint2-dense-badge")
  }

  func testDenseBadgeAbsentOnHeldLine() {
    // Demo line 4 (21.20–27.20): "Hold it here" — 3 words over 6s
    let app = demo(seek: "22", paused: true, clean: true)
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
    XCTAssertFalse(app.otherElements["denseBadge"].exists)
  }

  // MARK: - Stage settings panel — practice controls

  func testStageSettingsPanelHasBlankWordsAndLoopControls() {
    // First-run mode opens the panel automatically
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.setupSeen", "NO", "-bar4bar.stage.intensity", "live"]
    app.launchEnvironment = ["BAR4BAR_AUTODEMO": "1", "BAR4BAR_DEMO_PAUSED": "1"]
    app.launch()
    XCTAssertTrue(app.buttons["stageBlankWords"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.buttons["stageLoopSection"].exists)
    attachScreen(named: "sprint2-practice-controls")
  }

  func testBlankWordsCyclesThroughFourValues() {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.setupSeen", "NO", "-bar4bar.stage.intensity", "live"]
    app.launchEnvironment = ["BAR4BAR_AUTODEMO": "1", "BAR4BAR_DEMO_PAUSED": "1"]
    app.launch()
    let btn = app.buttons["stageBlankWords"]
    XCTAssertTrue(btn.waitForExistence(timeout: 12))
    XCTAssertEqual(btn.label, "Blank off")
    // Atmosphere → singing → practice, with each group on its own remote row.
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.down)
    assertFocused(btn)
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Every 2nd")
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Every 3rd")
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Every 4th")
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Blank off")
  }

  func testLoopSectionButtonToggles() {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.setupSeen", "NO", "-bar4bar.stage.intensity", "live"]
    app.launchEnvironment = ["BAR4BAR_AUTODEMO": "1", "BAR4BAR_DEMO_PAUSED": "1"]
    app.launch()
    let btn = app.buttons["stageLoopSection"]
    XCTAssertTrue(btn.waitForExistence(timeout: 12))
    XCTAssertEqual(btn.label, "Loop: off")
    // Navigate to loop: down to singing, down to practice, right to loop.
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.right)
    assertFocused(btn)
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Loop: on")
    XCUIRemote.shared.press(.select); XCTAssertEqual(btn.label, "Loop: off")
  }

  // MARK: - Song summary card

  func testSongSummaryAppearsAfterDemoEnds() {
    // Demo duration is 52.0s; seek to 51 and play the last second
    let app = demo(seek: "51", paused: false, clean: false)
    XCTAssertTrue(app.otherElements["songSummaryCard"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["songSummaryCount"].exists)
    attachScreen(named: "sprint2-song-summary")
  }

  // MARK: - Party flip flash

  func testPartyFlipFlashAppearsAtAgentHandoff() {
    // Demo line 5 (27.80–31.00) has agent:"v2" — the first side-B line.
    // With partyMode = "Take turns", crossing t=27.80 triggers the flash.
    let app = XCUIApplication()
    app.launchArguments = [
      "-bar4bar.stage.partyMode", "Take turns",
      "-bar4bar.stage.intensity", "live",
    ]
    app.launchEnvironment = [
      "BAR4BAR_AUTODEMO": "1",
      "BAR4BAR_DEMO_SEEK": "27.5",
      "BAR4BAR_DEMO_PAUSED": "0",
      "BAR4BAR_SKIP_STAGE_SETUP": "1",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.staticTexts["partyFlipFlash"].waitForExistence(timeout: 5))
    attachScreen(named: "sprint2-party-flip")
  }

  // MARK: - Helpers

  private func demo(seek: String, paused: Bool, clean: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment = [
      "BAR4BAR_AUTODEMO": "1",
      "BAR4BAR_DEMO_SEEK": seek,
      "BAR4BAR_DEMO_PAUSED": paused ? "1" : "0",
      "BAR4BAR_STAGE_CLEAN": clean ? "1" : "0",
      "BAR4BAR_SKIP_STAGE_SETUP": "1",
    ]
    app.launch()
    return app
  }

  private func assertFocused(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasFocus == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, file: file, line: line)
  }

  private func attachScreen(named name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
