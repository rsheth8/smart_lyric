import Foundation

public struct GlassField: Equatable, Sendable {
  public var iris: Double
  public var warmth: Double
  public var envelope: Double
  public var leftMeter: Double
  public var rightMeter: Double
  public var sleeve: Double
  public var breath: Double
  public var cheer: Double
  public var hold: Double

  public init(iris: Double, warmth: Double, envelope: Double,
              leftMeter: Double, rightMeter: Double,
              sleeve: Double, breath: Double, cheer: Double, hold: Double) {
    self.iris = iris; self.warmth = warmth; self.envelope = envelope
    self.leftMeter = leftMeter; self.rightMeter = rightMeter
    self.sleeve = sleeve; self.breath = breath; self.cheer = cheer; self.hold = hold
  }
}

public enum GlassMath {

  // MARK: - Artwork field color

  /// Returns a darkened, low-chroma version of `dominant` suitable for the glass
  /// field background, or nil when the artwork has no useful hue (caller uses
  /// fieldFallback).
  public static func field(dominant: (r: Double, g: Double, b: Double)?) -> (r: Double, g: Double, b: Double)? {
    guard let d = dominant else { return nil }
    let lch = RGB(r: d.r, g: d.g, b: d.b).oklch
    guard lch.c >= AccentMath.minChroma else { return nil }   // greyscale → fallback
    let out = OKLCH(
      l: clamp(lch.l, 0.22...0.32),
      c: clamp(lch.c, 0.035...0.070),
      h: lch.h
    ).rgb
    return (r: out.r, g: out.g, b: out.b)
  }

  // MARK: - Per-frame field derivation

  public static func field(
    state: StagePresentation,
    intensity: StageIntensity,
    partyMode: String,
    sideA: Bool,
    cheer: Double,
    playing: Bool,
    reduceMotion: Bool,
    nextVocalIn: Double?,
    inLongGap: Bool,
    wordKick: Double,
    previewSeconds: Double
  ) -> GlassField {

    // hold
    let hold: Double = state.hold != nil ? 1.0 : 0.0

    // breath — pre-vocal blackout within the breathWindow
    let breathWindow = StageLookMath.breathWindow  // 0.40
    let breath: Double
    if inLongGap, let nvi = nextVocalIn, nvi > 0, nvi <= breathWindow {
      breath = clamp(1 - nvi / breathWindow, 0...1)
    } else {
      breath = 0
    }

    // iris
    let base: Double = intensity == .focus ? 0.18 : intensity == .live ? 0.48 : 0.72
    let isChorus = state.kind == .chorus || state.kind == .finale
    let isInstrumental = state.kind == .instrumental
    let section: Double = isChorus ? 0.20 : isInstrumental ? 0.04 : 0.00
    let iris = clamp(
      (base + section) * (1 - 0.82 * hold) * (1 - breath) + 0.22 * cheer,
      0...1
    )

    // warmth — cross-fade between section targets
    let warmth = lerp(warmthTarget(state.previousKind), warmthTarget(state.kind), state.sectionTransition)

    // sleeve — instrumental only
    let sleeve: Double = isInstrumental ? 0.50 * (1 - breath) : 0

    // meters
    let energy = clamp(0.10 + 0.40 * wordKick + 0.50 * cheer + 0.25 * hold, 0...1)
    var left = energy
    var right = energy
    if partyMode == "Take turns" {
      if sideA {
        left  = clamp(left  + 0.22, 0...1)
        right = clamp(right * 0.45, 0...1)
      } else {
        right = clamp(right + 0.22, 0...1)
        left  = clamp(left  * 0.45, 0...1)
      }
    }

    // envelope
    let envelope: Double = playing
      ? clamp(0.20 + 0.55 * iris, 0...1)
      : clamp(0.16 + 0.20 * cheer, 0...1)

    return GlassField(
      iris: iris,
      warmth: warmth,
      envelope: envelope,
      leftMeter: left,
      rightMeter: right,
      sleeve: sleeve,
      breath: breath,
      cheer: clamp(cheer, 0...1),
      hold: hold
    )
  }

  // MARK: - Helpers

  private static func warmthTarget(_ kind: Choreography.Kind) -> Double {
    switch kind {
    case .verse, .build:  return 1.00
    case .chorus:         return 0.32
    case .finale:         return 0.18
    case .instrumental:   return 0.55
    }
  }
}

// File-private helpers — no namespace pollution
private func clamp(_ v: Double, _ range: ClosedRange<Double>) -> Double {
  max(range.lowerBound, min(range.upperBound, v))
}

private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
  a + (b - a) * clamp(t, 0...1)
}
