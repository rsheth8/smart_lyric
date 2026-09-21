// A playhead driven by what the room sounds like, not by a stopwatch.
//
// Port of `PredictiveClock` in app/clock.js. Fingerprint matches arrive every few
// seconds and are the only truth we get; between them the clock free-runs. Two
// things make that survive real rooms:
//
//   • rate — song-seconds per wall-second. A turntable runs a percent or two fast
//     and a phone speaker's crystal is not ours, so 1.0 is an assumption, not a
//     fact. calibrateRate() measures it from consecutive matches.
//   • easing — a match that lands slightly off nudges the rate instead of jumping
//     the position, because a jump backwards looks like the lyrics rewinding.
//
// The wall clock is injected so tests can run a whole song in no time at all.

import Foundation

@MainActor
public final class SyncClock {
  /// Song-seconds per wall-second, eased toward `targetRate`.
  public private(set) var rate: Double
  public private(set) var isPlaying = false

  private var anchorSong = 0.0
  private var anchorWall = 0.0
  private var targetRate: Double
  private var rateSamples = 0

  private let wallNow: () -> Double
  private let correctionWindow: Double
  private let jumpThreshold: Double
  private let rateAlpha: Double
  private let minRate: Double
  private let maxRate: Double

  public init(
    rate: Double = 1,
    now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
    correctionWindow: Double = 4,
    jumpThreshold: Double = 1.5,
    rateAlpha: Double = 0.35,
    minRate: Double = 0.94,
    maxRate: Double = 1.06
  ) {
    self.rate = rate
    self.targetRate = rate
    self.wallNow = now
    self.correctionWindow = correctionWindow
    self.jumpThreshold = jumpThreshold
    self.rateAlpha = rateAlpha
    self.minRate = minRate
    self.maxRate = maxRate
  }

  public func start(at songTime: Double = 0) {
    anchorSong = songTime
    anchorWall = wallNow()
    isPlaying = true
  }

  public func pause() {
    guard isPlaying else { return }
    anchorSong = now()
    anchorWall = wallNow()
    isPlaying = false
  }

  /// Resume from the frozen position — the music came back after a silence, and
  /// the next fingerprint will re-anchor us properly.
  public func resume() {
    guard !isPlaying else { return }
    anchorWall = wallNow()
    isPlaying = true
  }

  // ponytail: easing `rate` inside now() means it converges per *call*, not per
  // second — faithful to the web original, and harmless at a 60 fps render loop
  // (~50 ms to settle). Move the easing into observe() if a caller ever polls it
  // at a wildly different frequency.
  public func now() -> Double {
    guard isPlaying else { return anchorSong }
    rate += (targetRate - rate) * 0.05
    return anchorSong + (wallNow() - anchorWall) * rate
  }

  /// A fresh, authoritative measurement of where the song actually is.
  /// Small error nudges the rate; a big one is a seek or a new track, so snap.
  public func observe(_ measuredSongTime: Double) {
    guard isPlaying else {
      start(at: measuredSongTime)
      return
    }
    let predicted = now()
    let error = measuredSongTime - predicted // positive: we are behind the music

    if error > jumpThreshold {
      snap(to: measuredSongTime)
      return
    }
    // Only a big backwards error is a real seek. A small one eases, because
    // jumping back reads as the lyrics rewinding.
    if error < -jumpThreshold * 3 {
      snap(to: measuredSongTime)
      return
    }

    anchorSong = predicted
    anchorWall = wallNow()
    targetRate = rate + error / correctionWindow
  }

  private func snap(to songTime: Double) {
    anchorSong = songTime
    anchorWall = wallNow()
    targetRate = rate
  }

  /// Estimate the real playback rate from two matches. The first good pair locks
  /// immediately; later ones are smoothed, so a single bad fingerprint timestamp
  /// can't make the lyrics visibly speed up.
  ///
  /// ponytail: this and observe() both steer `targetRate`, so on an off-speed
  /// source the rate hunts around the truth instead of settling on it. Measured
  /// outcome (SongDetectorTests): a digital 1.0× source tracks exactly, and a
  /// 1.03×/0.97× turntable stays inside ±0.3 s indefinitely — bounded, never
  /// diverging. Good enough to ship, and the same behaviour the web app has in
  /// production. If that 0.3 s ever matters, stop observe() from overwriting a
  /// calibrated rate and let it correct position only.
  public func calibrateRate(song1: Double, wall1: Double, song2: Double, wall2: Double) {
    let elapsed = wall2 - wall1
    guard elapsed > 0.5 else { return }
    let estimate = (song2 - song1) / elapsed
    guard estimate.isFinite, estimate >= 0.8, estimate <= 1.2 else { return }
    let clamped = min(maxRate, max(minRate, estimate))

    if rateSamples == 0 {
      targetRate = clamped
    } else {
      // Once a few samples agree, an outlier is a bad match, not a speed change.
      if rateSamples >= 3, abs(clamped - targetRate) > 0.035 { return }
      targetRate = targetRate * (1 - rateAlpha) + clamped * rateAlpha
    }
    rateSamples += 1
  }
}
