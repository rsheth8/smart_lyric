import XCTest
@testable import Bar4BarKit

final class FeedbackGuardTests: XCTestCase {
  func testASingerIsLoudInBurstsAndNeverTripsIt() {
    let guardian = FeedbackGuard()
    // Loud for half a second, breath, loud again — a belted chorus, not a howl.
    var now = 0.0
    for _ in 0..<20 {
      for _ in 0..<5 { XCTAssertFalse(guardian.update(0.8, now: now)); now += 0.1 }
      XCTAssertFalse(guardian.update(0.2, now: now)); now += 0.1
    }
  }

  func testASustainedHowlTripsItOnceTheHoldHasPassed() {
    let guardian = FeedbackGuard(level: 0.55, hold: 0.9)
    XCTAssertFalse(guardian.update(0.9, now: 10.0))
    XCTAssertFalse(guardian.update(0.9, now: 10.5))
    XCTAssertTrue(guardian.update(0.9, now: 10.9))
  }

  func testItRearmsAfterFiring() {
    let guardian = FeedbackGuard(level: 0.55, hold: 0.9)
    // Quarter-second steps: exact in binary, so the hold boundary isn't at
    // the mercy of 1.4 - 0.5 == 0.8999999999999999.
    _ = guardian.update(0.9, now: 0.5)
    XCTAssertTrue(guardian.update(0.9, now: 1.5))
    // Still howling: the next confirmation needs a fresh full hold.
    XCTAssertFalse(guardian.update(0.9, now: 1.75))
    XCTAssertFalse(guardian.update(0.9, now: 2.5))
    XCTAssertTrue(guardian.update(0.9, now: 2.75))
  }

  /// The bug the web version fixed: a clock that reads 0 is a real time.
  func testATimestampOfZeroStillArmsTheTimer() {
    let guardian = FeedbackGuard(level: 0.55, hold: 0.9)
    XCTAssertFalse(guardian.update(0.9, now: 0))
    XCTAssertTrue(guardian.update(0.9, now: 0.9))
  }

  func testResetForgetsAHalfArmedHowl() {
    let guardian = FeedbackGuard(level: 0.55, hold: 0.9)
    _ = guardian.update(0.9, now: 0)
    guardian.reset()
    XCTAssertFalse(guardian.update(0.9, now: 0.9))
  }

  func testGarbageLevelsNeverTripIt() {
    let guardian = FeedbackGuard()
    for step in 0..<30 { XCTAssertFalse(guardian.update(.nan, now: Double(step))) }
  }
}

final class MonitorPolicyTests: XCTestCase {
  func testLatencyVerdicts() {
    XCTAssertEqual(Monitor.verdict(0.012), .comfortable)
    XCTAssertEqual(Monitor.verdict(0.025), .comfortable)
    XCTAssertEqual(Monitor.verdict(0.040), .noticeable)
    XCTAssertEqual(Monitor.verdict(0.050), .noticeable)
    XCTAssertEqual(Monitor.verdict(0.120), .tooSlow)
  }

  /// A route that won't say is not a reason to refuse — the override exists
  /// precisely because the measurement is a floor anyway.
  func testAnUnreportedLatencyIsNotAVerdictAgainst() {
    XCTAssertEqual(Monitor.verdict(0), .comfortable)
    XCTAssertEqual(Monitor.verdict(.nan), .comfortable)
  }

  /// The relay validates `monitor_on` against app/analytics.js. A case renamed
  /// or added on one side only means the TV's events get 400'd and vanish.
  func testLatencyNamesMatchTheAnalyticsAllowlist() {
    XCTAssertEqual(Monitor.Latency.allCases.map(\.rawValue), ["comfortable", "noticeable", "tooSlow"])
  }

  func testOnlyASlowRoomGetsAdvice() {
    XCTAssertNil(Monitor.advice(.comfortable))
    XCTAssertNotNil(Monitor.advice(.noticeable))
    XCTAssertNotNil(Monitor.advice(.tooSlow))
  }

  func testWetDryMixClampsToTheRangeTheReverbTakes() {
    XCTAssertEqual(Monitor.wetDryMix(0), 0)
    XCTAssertEqual(Monitor.wetDryMix(0.25), 25)
    XCTAssertEqual(Monitor.wetDryMix(1), 100)
    XCTAssertEqual(Monitor.wetDryMix(-1), 0)
    XCTAssertEqual(Monitor.wetDryMix(3), 100)
    XCTAssertEqual(Monitor.wetDryMix(.nan), 0)
  }
}
