import Foundation

/// Shared clock contract: song position in seconds + playing flag.
public protocol SyncClock: AnyObject {
  func now() -> Double
  func isPlaying() -> Bool
}

/// Streaming follow-mode clock (Apple Music / Spotify).
///
/// When `getPosition` is set (exact SDK playhead), `now()` reads it directly and
/// `observe` is a no-op. Otherwise free-runs between noisy polls with deadband /
/// ease / jump bands matching `app/clock.js` `StreamingClock`.
public final class StreamingClock: SyncClock, @unchecked Sendable {
  public var lead: Double
  public var jumpThreshold: Double
  public var ease: Double
  public var deadband: Double

  private let isPlayingFn: () -> Bool
  private let getPosition: (() -> Double)?
  private let nowFn: () -> Double
  private var anchorSong: Double = 0
  private var anchorWall: Double

  public init(
    isPlaying: @escaping () -> Bool,
    getPosition: (() -> Double)? = nil,
    now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
    lead: Double = 0,
    jumpThreshold: Double = 1.5,
    ease: Double = 0.2,
    deadband: Double = 0.15
  ) {
    self.isPlayingFn = isPlaying
    self.getPosition = getPosition
    self.nowFn = now
    self.lead = lead
    self.jumpThreshold = jumpThreshold
    self.ease = ease
    self.deadband = deadband
    self.anchorWall = now()
  }

  public func position() -> Double {
    if let getPosition { return getPosition() }
    if !isPlaying() { return anchorSong }
    return anchorSong + (nowFn() - anchorWall)
  }

  public func now() -> Double {
    position() + lead
  }

  public func isPlaying() -> Bool {
    isPlayingFn()
  }

  public func set(_ songTime: Double) {
    anchorSong = songTime
    anchorWall = nowFn()
  }

  public func observe(_ measuredSongTime: Double) {
    if getPosition != nil { return }
    if !isPlaying() {
      set(measuredSongTime)
      return
    }
    let predicted = position()
    let error = measuredSongTime - predicted
    let mag = abs(error)
    if mag > jumpThreshold {
      set(measuredSongTime)
      return
    }
    if mag < deadband { return }
    anchorSong = predicted + error * ease
    anchorWall = nowFn()
  }
}

/// Position pushed in externally (companion / overlay mirror).
public final class PassiveClock: SyncClock, @unchecked Sendable {
  private var positionValue: Double = 0
  private var playing: Bool = false

  public init() {}

  public func push(position: Double, playing: Bool) {
    positionValue = position
    self.playing = playing
  }

  public func now() -> Double { positionValue }
  public func isPlaying() -> Bool { playing }
}
