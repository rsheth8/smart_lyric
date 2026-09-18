import SwiftUI
import Bar4BarCore

/// Eases room lighting toward the current camera so look changes do not pop.
/// Breath is clock-accurate (the blackout is a cue, not a filter).
///
/// This is a plain class on purpose: putting the grade in `@State` and writing
/// it from `TimelineView` caused a second SwiftUI invalidation every frame,
/// which is what made the stage hitch and stole focus from the remote.
final class StageLightClock {
  private var light = StageLight.document
  private var lastTick: Date?

  func advance(
    look: StageLook,
    nextVocalIn: Double?,
    now: Date,
    reduceMotion: Bool
  ) -> StageLight {
    let target = StageLight.target(for: look, nextVocalIn: nextVocalIn)
    if reduceMotion || lastTick == nil {
      light = target
      lastTick = now
      return light
    }
    let raw = now.timeIntervalSince(lastTick ?? now)
    lastTick = now
    let dt = min(0.05, max(1.0 / 120.0, raw))
    var next = light.movingToward(target, dt: dt, tau: 0.24)
    next.breath = target.breath
    light = next
    return light
  }
}
