import Foundation

public enum Match {
  public static let durationNearSec = 2.5
  public static let durationFarSec = 12.0
  public static let durationRejectSec = 22.0

  private static func sec(_ v: Double?) -> Double? {
    guard let n = v, n.isFinite, n > 0 else { return nil }
    return n
  }

  /// 1 when within near, linear to 0 by far; `nil` when either length unknown.
  public static func durationScore(targetSec: Double?, candidateSec: Double?) -> Double? {
    guard let a = sec(targetSec), let b = sec(candidateSec) else { return nil }
    let off = abs(a - b)
    if off <= durationNearSec { return 1 }
    if off >= durationFarSec { return 0 }
    return 1 - (off - durationNearSec) / (durationFarSec - durationNearSec)
  }

  public static func durationMismatch(targetSec: Double?, candidateSec: Double?) -> Bool {
    guard let a = sec(targetSec), let b = sec(candidateSec) else { return false }
    return abs(a - b) >= durationRejectSec
  }

  public static func candidateScore(
    titleScore: Double,
    targetDuration: Double?,
    candidateDuration: Double?
  ) -> Double {
    guard let d = durationScore(targetSec: targetDuration, candidateSec: candidateDuration) else {
      return titleScore
    }
    return titleScore + 0.6 * (d - 0.5)
  }

  /// Prefer richest present result; skip gross duration mismatches when known.
  public static func preferResult(
    _ results: [LyricsResult?],
    targetDuration: Double?
  ) -> LyricsResult? {
    let present = results.compactMap { $0 }
    guard !present.isEmpty else { return nil }
    guard let target = sec(targetDuration) else { return present[0] }
    let plausible = present.filter { !durationMismatch(targetSec: target, candidateSec: $0.meta.duration) }
    return (plausible.isEmpty ? present : plausible)[0]
  }
}
