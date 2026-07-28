import Foundation

/// A self-driving song clock for the built-in demo track.
///
/// MusicKit does not run in the tvOS simulator and needs a subscription on
/// device, so without this there is no way to see — or iterate on — the karaoke
/// screen at all. This is the same `SyncClock` contract the real players
/// satisfy, so `KaraokeView` cannot tell the difference: the demo exercises the
/// genuine display path rather than a mock of it.
///
/// Unlike `StreamingClock` there is no external truth to ease toward; the clock
/// *is* the truth. It free-runs from an anchor, holds position across a pause,
/// and wraps at `duration` so a demo left on screen keeps performing.
public final class DemoClock: SyncClock, @unchecked Sendable {
  /// Song length; the clock wraps back to `0` here when `loops` is true.
  public let duration: Double
  public let loops: Bool

  private let nowFn: () -> Double
  /// Song position captured at the moment of the last anchor.
  private var anchorSong: Double
  /// Wall time of the last anchor.
  private var anchorWall: Double
  private var playing: Bool

  public init(
    duration: Double,
    loops: Bool = true,
    now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.duration = max(0, duration)
    self.loops = loops
    self.nowFn = now
    self.anchorSong = 0
    self.anchorWall = now()
    self.playing = false
  }

  public func now() -> Double {
    guard playing else { return anchorSong }
    let raw = anchorSong + (nowFn() - anchorWall)
    return wrap(raw)
  }

  public func isPlaying() -> Bool { playing }

  public func play() {
    guard !playing else { return }
    // Re-anchor so the paused span doesn't count as elapsed song time.
    anchorWall = nowFn()
    playing = true
  }

  public func pause() {
    guard playing else { return }
    // Freeze the position we had *before* clearing the flag, or `now()` would
    // fall back to a stale anchor and the playhead would jump backwards.
    anchorSong = now()
    anchorWall = nowFn()
    playing = false
  }

  public func toggle() {
    playing ? pause() : play()
  }

  public func seek(to songTime: Double) {
    anchorSong = wrap(songTime)
    anchorWall = nowFn()
  }

  public func restart() {
    seek(to: 0)
  }

  private func wrap(_ t: Double) -> Double {
    guard t.isFinite else { return 0 }
    guard duration > 0 else { return max(0, t) }
    if t < 0 { return 0 }
    if t < duration { return t }
    // Past the end: loop back around, or park on the final frame.
    guard loops else { return duration }
    return t.truncatingRemainder(dividingBy: duration)
  }
}
