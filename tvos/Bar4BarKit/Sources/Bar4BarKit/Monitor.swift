// Hearing yourself sing, through the TV.
//
// The web app monitors a microphone that only hears the singer, through an
// output the singer usually has on headphones. A living room has neither
// luxury, so the two things this file exists for are both hazards rather than
// features:
//
//   • feedback. The mic is in the same room as the speakers it feeds. Past some
//     gain that loop runs away and howls. `FeedbackGuard` is a port of the web
//     policy, which watches for a level that stays high rather than one that
//     peaks — a singer is loud in bursts, a howl is loud continuously.
//
//   • latency. A singer hears their own voice by bone conduction instantly and
//     through the speakers late, and past about 25ms that gap stops sounding
//     like reverb and starts sounding like a slapback echo that fights them.
//     An Apple TV's output goes out over HDMI into a television, which is one
//     of the slowest audio paths in a house.
//
// Both are policy, not audio, so both are pure and unit-tested here. The engine
// that acts on them is in the app target, because an AVAudioEngine cannot run
// in a test.

import Foundation

public enum Monitor {
  /// Sustained monitor level above this is a howl starting, not a singer.
  public static let feedbackLevel = 0.55
  /// How long it has to sustain before we pull the monitor down.
  public static let feedbackHold = 0.9
  /// Round trip a singer stops noticing.
  public static let comfortableLatency = 0.025
  /// Past here monitoring fights the singer rather than helping them.
  public static let usableLatency = 0.050
  /// Enough to flatter a voice without smearing the words.
  public static let defaultReverb = 0.25

  /// The raw values are an analytics allowlist in app/analytics.js (`monitor_on`).
  public enum Latency: String, CaseIterable, Sendable {
    case comfortable, noticeable, tooSlow
  }

  /// What a measured round trip means for a singer.
  ///
  /// ponytail: this judges only the latency the system will admit to.
  /// AVAudioSession reports the Apple TV's own input and output latency and
  /// knows nothing about what the television does after that — and a TV's
  /// picture processing can add 100ms on its own. So a `comfortable` verdict
  /// means "nothing we can measure is wrong", never "this will sound good",
  /// which is exactly why the singer gets an override and not just a verdict.
  public static func verdict(_ seconds: Double) -> Latency {
    guard seconds.isFinite, seconds > 0 else { return .comfortable }
    if seconds <= comfortableLatency { return .comfortable }
    if seconds <= usableLatency { return .noticeable }
    return .tooSlow
  }

  /// 0...1 → the wet/dry percentage AVAudioUnitReverb wants.
  public static func wetDryMix(_ amount: Double) -> Float {
    guard amount.isFinite else { return 0 }
    return Float(min(1, max(0, amount)) * 100)
  }

  /// What the room should be told about a latency verdict.
  public static func advice(_ latency: Latency) -> String? {
    switch latency {
    case .comfortable: nil
    case .noticeable: "Your voice may sound a touch behind."
    case .tooSlow: "This TV is slow enough that you'll hear yourself echo."
    }
  }
}

/// Howl guard. Monitoring a mic through the same speakers it can hear is a
/// feedback loop; this notices the runaway before it deafens anyone.
///
/// Pure — `now` is passed in — so the policy is testable. Port of FeedbackGuard
/// in app/karaoke.js, including the sentinel that bit there: the armed time is
/// nil rather than 0, so a clock that legitimately reads 0 still arms the timer
/// instead of looking like "not armed".
public final class FeedbackGuard {
  private let level: Double
  private let hold: Double
  private var since: Double?

  public init(level: Double = Monitor.feedbackLevel, hold: Double = Monitor.feedbackHold) {
    self.level = level
    self.hold = hold
  }

  public func reset() {
    since = nil
  }

  /// True the moment a sustained howl is confirmed. Rearms itself after firing,
  /// so a monitor turned back up gets the same protection again.
  public func update(_ micLevel: Double, now: Double) -> Bool {
    guard micLevel.isFinite, micLevel >= level else {
      since = nil
      return false
    }
    guard let armed = since else {
      since = now
      return false
    }
    guard now - armed >= hold else { return false }
    since = nil
    return true
  }
}
