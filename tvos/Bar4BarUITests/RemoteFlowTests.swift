import XCTest

/// Drives the app the way a couch does, with the Siri Remote: tabs, shelves,
/// the stage, pause, a timing nudge and Menu back. Every step also leaves a
/// screenshot in the result bundle for eyeballing motion and layout.
final class RemoteFlowTests: XCTestCase {
  private let app = XCUIApplication()
  private let remote = XCUIRemote.shared

  func testCouchFlow() {
    app.launchArguments += ["-room", "BARBAR42"]
    app.launch()
    XCTAssertTrue(waitUntil(15) { self.app.buttons["Home"].hasFocus }, "launch focus starts on the tab bar")
    snap("01-home", after: 3)

    remote.press(.right)
    XCTAssertTrue(waitUntil { self.app.buttons["Search"].hasFocus })
    snap("02-search", after: 2)
    remote.press(.right)
    XCTAssertTrue(labelled("Your phone is the remote").waitForExistence(timeout: 5))
    snap("03-phone-remote", after: 2)
    remote.press(.left)
    remote.press(.left)
    XCTAssertTrue(waitUntil { self.app.buttons["Home"].hasFocus })

    // Shelves: focus lights up the spotlight and glides each row under the header.
    // Down to the last row, the chart, whatever history this simulator has. The snaps
    // double as settles: a press right after a tab change can be dropped.
    for step in 1...3 {
      snap("04-down-\(step)", after: 1.5)
      remote.press(.down)
    }
    XCTAssertTrue(waitUntil { self.focusedLabel.contains(",") }, "focus should land on a song card")
    let picked = focusedLabel
    snap("05-chart", after: 1.5)
    // "NUMBER 3 RIGHT NOW": tells this card apart from its copy in Sing again after singing.
    let eyebrow = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "RIGHT NOW")).firstMatch.label
    remote.press(.right)
    XCTAssertTrue(waitUntil { self.focusedLabel.contains(",") && self.focusedLabel != picked }, "right should move along the row")
    remote.press(.right)
    snap("06-along-the-row", after: 1.5)
    remote.press(.left)
    remote.press(.left)
    XCTAssertTrue(waitUntil { self.focusedLabel == picked })

    // The stage: its hints only show once the lyrics are up.
    remote.press(.select)
    XCTAssertTrue(labelled("Timing").waitForExistence(timeout: 20), "the stage should open with lyrics")
    snap("07-stage", after: 0.5)
    for i in 0..<12 { snap(String(format: "08-stage-%02d", i), after: 2) }

    remote.press(.playPause)
    XCTAssertTrue(labelled("Paused").waitForExistence(timeout: 5))
    snap("09-paused", after: 0.8)
    remote.press(.playPause)
    XCTAssertTrue(waitUntil { !self.labelled("Paused").exists })
    remote.press(.right)
    XCTAssertTrue(labelled("+0.1s").waitForExistence(timeout: 5))
    snap("10-nudged", after: 0.8)

    remote.press(.menu)
    XCTAssertTrue(waitUntil { !self.labelled("Timing").exists && !self.labelled("+0.1s").exists }, "Menu should close the stage")
    XCTAssertTrue(waitUntil { self.focusedLabel == picked && self.labelled(eyebrow).exists }, "focus should return to the card that was picked, got \(focusedLabel)")
    snap("11-back-home", after: 1.5)
  }

  private var focusedLabel: String {
    let element = app.descendants(matching: .any).matching(NSPredicate(format: "hasFocus == true")).firstMatch
    return element.exists ? element.label : ""
  }

  private func labelled(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  private func waitUntil(_ timeout: TimeInterval = 8, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return condition()
  }

  private func snap(_ name: String, after seconds: Double) {
    Thread.sleep(forTimeInterval: seconds)
    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
