import XCTest
@testable import Bar4BarCore

final class AudienceAccentTests: XCTestCase {
  func testRapidCheersCoalesceWithoutExtendingAccent() {
    var event = AudienceAccent()
    XCTAssertTrue(event.cheer(at: 10))
    XCTAssertFalse(event.cheer(at: 10.7))
    XCTAssertEqual(event.sequence, 1)
    XCTAssertEqual(event.startedAt, 10)
    XCTAssertEqual(event.amount(at: 10), 0)
    XCTAssertEqual(event.amount(at: 10.2), 1, accuracy: 0.00001)
    XCTAssertEqual(event.amount(at: 11.21), 0)
    XCTAssertTrue(event.cheer(at: 11.3))
    XCTAssertEqual(event.sequence, 2)
  }
  func testClearAndInvalidInputsDoNotInventEvents() {
    var event = AudienceAccent()
    XCTAssertFalse(event.cheer(at: .nan))
    XCTAssertFalse(event.cheer(at: .infinity))
    XCTAssertEqual(event.sequence, 0)
    XCTAssertTrue(event.cheer(at: 0))
    XCTAssertEqual(event.amount(at: -1), 0)
    event.clear()
    XCTAssertFalse(event.isActive(at: 0.2))
    XCTAssertEqual(event.sequence, 1)
  }
}
