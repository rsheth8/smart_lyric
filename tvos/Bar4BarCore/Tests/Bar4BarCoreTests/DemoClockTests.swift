import XCTest
@testable import Bar4BarCore

/// A hand-cranked wall clock so these tests are deterministic rather than timed.
private final class FakeWall {
  var t: Double = 1000
  func now() -> Double { t }
  func advance(_ dt: Double) { t += dt }
}

final class DemoClockTests: XCTestCase {

  func testStartsPausedAtZero() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    XCTAssertEqual(clock.now(), 0)
    XCTAssertFalse(clock.isPlaying())
  }

  func testFreeRunsWhilePlaying() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.play()
    wall.advance(4.5)
    XCTAssertEqual(clock.now(), 4.5, accuracy: 1e-9)
  }

  /// The bug this guards: pausing without freezing the current position first
  /// makes `now()` fall back to a stale anchor, so the playhead jumps backwards
  /// the instant you hit pause.
  func testPauseHoldsPositionAndDoesNotRewind() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.play()
    wall.advance(7)
    clock.pause()
    XCTAssertEqual(clock.now(), 7, accuracy: 1e-9)

    // Time passing while paused must not advance the song.
    wall.advance(30)
    XCTAssertEqual(clock.now(), 7, accuracy: 1e-9)
  }

  func testResumeDoesNotCountThePausedSpan() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.play()
    wall.advance(5)
    clock.pause()
    wall.advance(100) // a long pause
    clock.play()
    wall.advance(2)
    XCTAssertEqual(clock.now(), 7, accuracy: 1e-9)
  }

  func testLoopsAtDuration() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 10, loops: true, now: wall.now)
    clock.play()
    wall.advance(23)
    XCTAssertEqual(clock.now(), 3, accuracy: 1e-9)
  }

  func testNonLoopingParksOnFinalFrame() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 10, loops: false, now: wall.now)
    clock.play()
    wall.advance(23)
    XCTAssertEqual(clock.now(), 10, accuracy: 1e-9)
  }

  func testSeekAndRestart() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.play()
    clock.seek(to: 20)
    wall.advance(1)
    XCTAssertEqual(clock.now(), 21, accuracy: 1e-9)

    clock.restart()
    XCTAssertEqual(clock.now(), 0, accuracy: 1e-9)
  }

  func testSeekClampsNegativeAndWraps() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 10, now: wall.now)
    clock.seek(to: -5)
    XCTAssertEqual(clock.now(), 0)
    clock.seek(to: 34)
    XCTAssertEqual(clock.now(), 4, accuracy: 1e-9)
  }

  func testTogglePlaysThenPauses() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.toggle()
    XCTAssertTrue(clock.isPlaying())
    wall.advance(3)
    clock.toggle()
    XCTAssertFalse(clock.isPlaying())
    XCTAssertEqual(clock.now(), 3, accuracy: 1e-9)
  }

  /// Repeated `play()` must not re-anchor and lose elapsed time.
  func testRedundantPlayIsANoOp() {
    let wall = FakeWall()
    let clock = DemoClock(duration: 50, now: wall.now)
    clock.play()
    wall.advance(4)
    clock.play()
    wall.advance(1)
    XCTAssertEqual(clock.now(), 5, accuracy: 1e-9)
  }
}
