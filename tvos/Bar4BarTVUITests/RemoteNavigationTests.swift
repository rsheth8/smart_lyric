import XCTest

final class RemoteNavigationTests: XCTestCase {
  private func demo(clean: Bool = false, paused: Bool = true, cue: String = "18") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.intensity", "live"]
    app.launchEnvironment["BAR4BAR_SKIP_STAGE_SETUP"] = "1"
    app.launchEnvironment["BAR4BAR_AUTODEMO"] = "1"
    app.launchEnvironment["BAR4BAR_DEMO_SEEK"] = cue
    app.launchEnvironment["BAR4BAR_DEMO_PAUSED"] = paused ? "1" : "0"
    app.launchEnvironment["BAR4BAR_STAGE_CLEAN"] = clean ? "1" : "0"
    app.launch()
    return app
  }

  func testSavedTimingAvailabilityAndCatalogRemoteNavigation() {
    let app = XCUIApplication()
    app.launchEnvironment = ["BAR4BAR_ROUTE": "search", "BAR4BAR_BROWSE_FIXTURE": "1"]
    app.launch()
    let first = app.buttons["song-bar4bar-browse-fixture-v1-words"]
    XCTAssertTrue(first.waitForExistence(timeout: 12))
    XCTAssertTrue(app.staticTexts["Word timing saved"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Approximate word guidance saved"].exists)
    assertFocused(first)
    XCUIRemote.shared.press(.down)
    assertFocused(app.buttons["song-bar4bar-browse-fixture-v1-estimated"])
    XCUIRemote.shared.press(.down)
    assertFocused(app.buttons["song-bar4bar-browse-fixture-v1-mixed"])
    XCTAssertTrue(app.staticTexts["Word timing + estimates saved"].exists)
    XCUIRemote.shared.press(.down)
    assertFocused(app.buttons["song-bar4bar-browse-fixture-v1-unchecked"])
    XCTAssertTrue(app.staticTexts["Timing checked on selection"].exists)
    XCUIRemote.shared.press(.up)
    assertFocused(app.buttons["song-bar4bar-browse-fixture-v1-mixed"])
    attachScreen(named: "glass-saved-timing")
  }

  func testIncomingSingerCaptionPreservesActivePhraseAndFocus() {
    let app = demo(clean: true, cue: "26")
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
    let phrase = app.otherElements["currentPhrase"]
    let before = phrase.frame
    XCUIRemote.shared.press(.select)
    for _ in 0..<3 { XCUIRemote.shared.press(.right) }
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(app.buttons["intensity-live"].waitForExistence(timeout: 5))
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.menu)
    let handoff = app.otherElements["singerHandoff"]
    XCTAssertTrue(handoff.waitForExistence(timeout: 5))
    XCTAssertTrue(handoff.label.contains("SIDE B"))
    XCTAssertEqual(phrase.frame, before)
    assertFocused(app.buttons["stageView"])
    attachScreen(named: "glass-incoming-singer")
  }

  func testCheerPreservesPausedPhraseAndRemoteFocus() {
    let app = demo(cue: "24")
    let play = app.buttons["transportPlayPause"]
    XCTAssertTrue(play.waitForExistence(timeout: 12))
    XCTAssertEqual(play.label, "Play")
    let phrase = app.otherElements["currentPhrase"]
    XCTAssertTrue(phrase.exists)
    let before = phrase.frame
    for _ in 0..<6 { XCUIRemote.shared.press(.right) }
    let cheer = app.buttons["stageCheer"]
    assertFocused(cheer)
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.select)
    assertFocused(cheer)
    XCTAssertEqual(play.label, "Play")
    XCTAssertEqual(phrase.frame, before)
    attachScreen(named: "glass-cheer-paused")
  }

  func testLongTranslationFitsAllIntensities() {
    for intensity in ["focus", "live", "headliner"] {
      let app = XCUIApplication()
      app.launchArguments = ["-bar4bar.stage.intensity", intensity]
      app.launchEnvironment = ["BAR4BAR_SKIP_STAGE_SETUP": "1", "BAR4BAR_AUTODEMO": "1",
        "BAR4BAR_DEMO_SEEK": "12", "BAR4BAR_DEMO_PAUSED": "1", "BAR4BAR_STAGE_CLEAN": "1",
        "BAR4BAR_STAGE_FIXTURE": "long"]
      app.launch()
      XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
      let words = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "canción"))
      XCTAssertGreaterThan(words.count, 0)
      // Centered layout: phrase sits at vertical center; 900 leaves room for faceplate.
      for word in words.allElementsBoundByIndex { XCTAssertLessThanOrEqual(word.frame.maxY, 900) }
      attachScreen(named: "glass-long-\(intensity)")
      app.terminate()
    }
  }

  func testHeadlinerChorusControlsRemainResponsive() {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.intensity", "headliner"]
    app.launchEnvironment = ["BAR4BAR_SKIP_STAGE_SETUP": "1", "BAR4BAR_AUTODEMO": "1",
      "BAR4BAR_DEMO_SEEK": "35.9", "BAR4BAR_DEMO_PAUSED": "0"]
    app.launch()
    XCTAssertTrue(app.buttons["transportPlayPause"].waitForExistence(timeout: 12))
    for _ in 0..<6 { XCUIRemote.shared.press(.right) }
    assertFocused(app.buttons["stageCheer"])
    XCUIRemote.shared.press(.select)
    assertFocused(app.buttons["stageCheer"])
    for _ in 0..<2 { XCUIRemote.shared.press(.left) }
    assertFocused(app.buttons["moreOptions"])
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
    attachScreen(named: "installation-headliner-responsive")
  }

  func testReducedMotionPreservesEntranceAndRoleCues() {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.intensity", "headliner"]
    app.launchEnvironment = ["BAR4BAR_SKIP_STAGE_SETUP": "1", "BAR4BAR_AUTODEMO": "1",
      "BAR4BAR_DEMO_SEEK": "12", "BAR4BAR_DEMO_PAUSED": "1", "BAR4BAR_STAGE_CLEAN": "1",
      "BAR4BAR_REDUCE_MOTION": "1"]
    app.launch()
    // Role chrome (YOUR STAGE, UP NEXT, READY) removed in WP-5. Verify phrase + catcher still present.
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.otherElements["currentPhrase"].exists)
    attachScreen(named: "glass-reduced-motion")
  }

  func testStagePickerRolesAndAutomaticDemo() {
    let app = demo(clean: true, cue: "3.6")
    let stage = app.buttons["showPlaybackControls"]
    XCTAssertTrue(stage.waitForExistence(timeout: 12))
    assertFocused(stage)
    XCUIRemote.shared.press(.select)
    let play = app.buttons["transportPlayPause"]
    XCTAssertTrue(play.waitForExistence(timeout: 5))
    assertFocused(play)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Skip forward 15 seconds"])
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Lyrics timing"])
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["stageView"])
    XCUIRemote.shared.press(.select)
    let live = app.buttons["intensity-live"]
    XCTAssertTrue(live.waitForExistence(timeout: 5))
    // Select a specific intensity regardless of a preference from a prior run.
    assertFocused(live)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["stageRoles"])
    XCUIRemote.shared.press(.select)
    XCTAssertEqual(app.buttons["stageRoles"].label, "Take turns")
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["stageDemoSource"])
    XCUIRemote.shared.press(.select)
    XCTAssertEqual(app.buttons["stageDemoSource"].label, "Automatic demo")
    XCUIRemote.shared.press(.menu)
    assertFocused(app.buttons["stageView"])
    // "APPROXIMATE WORD GUIDANCE" banner removed in Glass stage (estimated words use reduced heat).
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(app.buttons["intensity-headliner"].waitForExistence(timeout: 5))
    assertFocused(app.buttons["intensity-headliner"])
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.menu)
    assertFocused(app.buttons["stageView"])
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["moreOptions"])
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Hide controls"])
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(stage.waitForExistence(timeout: 5))
    XCUIRemote.shared.press(.left)
    XCTAssertTrue(play.waitForExistence(timeout: 5))
    assertFocused(play)
    attachScreen(named: "listening-room-controls")
  }

  func testFirstRunOffersStageChoice() {
    let app = XCUIApplication()
    app.launchArguments = ["-bar4bar.stage.setupSeen", "NO", "-bar4bar.stage.intensity", "live"]
    app.launchEnvironment["BAR4BAR_AUTODEMO"] = "1"
    app.launchEnvironment["BAR4BAR_DEMO_PAUSED"] = "1"
    app.launch()
    XCTAssertTrue(app.buttons["intensity-live"].waitForExistence(timeout: 12))
    assertFocused(app.buttons["intensity-live"])
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.menu)
    XCTAssertTrue(app.buttons["transportPlayPause"].waitForExistence(timeout: 5))
    attachScreen(named: "phrase-board-first-run")
  }

  func testPlayingStageHidesControlsAfterInactivity() {
    let app = demo(paused: false)
    let pause = app.buttons["transportPlayPause"]
    XCTAssertTrue(pause.waitForExistence(timeout: 10))
    XCTAssertTrue(pause.waitForNonExistence(timeout: 12))
    let stage = app.buttons["showPlaybackControls"]
    XCTAssertTrue(stage.exists)
    assertFocused(stage)
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(pause.waitForExistence(timeout: 3))
    assertFocused(pause)
    XCUIRemote.shared.press(.select)
    XCTAssertEqual(pause.label, "Play")
    Thread.sleep(forTimeInterval: 9)
    XCTAssertTrue(pause.exists, "Paused controls must stay available")
  }

  func testTimingPanelAndMoreReturnFocus() {
    let app = demo()
    let play = app.buttons["transportPlayPause"]
    XCTAssertTrue(play.waitForExistence(timeout: 10))
    assertFocused(play)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Lyrics timing"])
    XCUIRemote.shared.press(.select)
    let earlier = app.buttons["Earlier"]
    XCTAssertTrue(earlier.waitForExistence(timeout: 5))
    assertFocused(earlier)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Reset"])
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.left)
    XCUIRemote.shared.press(.left)
    XCUIRemote.shared.press(.select)
    XCTAssertEqual(app.staticTexts["timingOffset"].label, "+0.05 seconds")
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["Later"])
    XCTAssertEqual(app.staticTexts["timingOffset"].label, "+0.05 seconds", "Moving focus cannot change timing")
    XCUIRemote.shared.press(.select)
    XCTAssertEqual(app.staticTexts["timingOffset"].label, "+0.00 seconds")
    XCUIRemote.shared.press(.menu)
    assertFocused(app.buttons["Lyrics timing"])
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["moreOptions"])
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(app.buttons["languageAid"].waitForExistence(timeout: 5))
    assertFocused(app.buttons["languageAid"])
    XCUIRemote.shared.press(.down)
    assertFocused(app.buttons["performanceMode"])
    XCUIRemote.shared.press(.select)
    XCUIRemote.shared.press(.menu)
    assertFocused(app.buttons["moreOptions"])
    XCUIRemote.shared.press(.up)
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 5))
    XCUIRemote.shared.press(.menu)
    XCTAssertTrue(play.waitForExistence(timeout: 5))  // controls now visible
    XCUIRemote.shared.press(.menu)                    // hide controls (menuHidCount = 1)
    XCTAssertTrue(app.buttons["showPlaybackControls"].waitForExistence(timeout: 3))
    XCUIRemote.shared.press(.menu)                    // second press from hidden → navigate home
    XCTAssertTrue(app.buttons["Back to the stage"].waitForExistence(timeout: 5))
    attachScreen(named: "listening-room-home")
  }

  func testOptionsStayOpenDuringPlayback() {
    let app = demo(paused: false)
    XCTAssertTrue(app.buttons["transportPlayPause"].waitForExistence(timeout: 10))
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    XCUIRemote.shared.press(.right)
    assertFocused(app.buttons["moreOptions"])
    XCUIRemote.shared.press(.select)
    XCTAssertTrue(app.buttons["languageAid"].waitForExistence(timeout: 5))
    Thread.sleep(forTimeInterval: 9)
    XCTAssertTrue(app.buttons["languageAid"].exists)
    assertFocused(app.buttons["languageAid"])
    XCUIRemote.shared.press(.menu)
    assertFocused(app.buttons["moreOptions"])
  }

  func testSpotifyOpensPairingAndCanGoBack() {
    let app = XCUIApplication()
    app.launchEnvironment["BAR4BAR_ROUTE"] = "spotify"
    app.launchEnvironment["BAR4BAR_FAKE_PAIR"] = "K7M-3QP"
    app.launch()
    XCTAssertTrue(app.staticTexts["K7M-3QP"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Cancel"].exists)
    XCUIRemote.shared.press(.menu)
    XCTAssertTrue(app.buttons["Experience Bar4Bar"].waitForExistence(timeout: 5))
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
