import Foundation

/// The karaoke screen's camera. One look at a time; hold is a modifier on
/// Document / Anthem, not a fifth camera.
public enum StageLook: String, Equatable, Sendable {
  case document
  case anthem
  case picture
  case breath
}

/// Pure look math — port of the on-stage direction rules. The view only
/// renders what this returns; it must not invent a fifth look per frame.
public enum StageLookMath {

  /// Last beat of a real instrumental before vocals return.
  public static let breathWindow = 0.40

  public static func resolve(
    part: Sections.Part?,
    gap: DisplayMath.GapState,
    inLongGap: Bool,
    reduceMotion: Bool
  ) -> StageLook {
    let eta = gap.nextVocalIn
    if inLongGap, let eta, eta <= breathWindow, eta >= 0, !reduceMotion {
      return .breath
    }
    if part?.isInstrumental == true
        || gap.instrumental
        || (inLongGap && (eta ?? .infinity) <= DisplayMath.instrumentalExitLead) {
      return .picture
    }
    if part == .chorus { return .anthem }
    return .document
  }

  /// Currently waiting in a silence long enough to be an instrumental, not a
  /// breath between phrases. Independent of the ♪ enter/exit hysteresis so
  /// Breath can still fire in the 0.5 s `exitLead` window.
  public static func inLongGap(lines: [LyricLine], t: Double, activeLi: Int) -> Bool {
    guard !lines.isEmpty, t.isFinite else { return false }
    if activeLi < 0 {
      let first = lines[0].start
      return first >= DisplayMath.instrumentalMinGap && t < first
    }
    let next = activeLi + 1
    if next >= lines.count {
      return t >= lines[activeLi].end
    }
    if t < lines[activeLi].end { return false }
    let gap = lines[next].start - lines[activeLi].end
    return gap >= DisplayMath.instrumentalMinGap && t < lines[next].start
  }

  public static func resolve(
    lines: [LyricLine],
    t: Double,
    sections: [Sections.Section],
    reduceMotion: Bool = false
  ) -> StageLook {
    let activeLi = DisplayMath.resolveActiveLine(lines, t: t)
    let gap = DisplayMath.gapState(lines: lines, t: t, activeLi: activeLi)
    let part = Sections.index(in: sections, at: t).map { sections[$0].part }
    return resolve(
      part: part,
      gap: gap,
      inLongGap: inLongGap(lines: lines, t: t, activeLi: activeLi),
      reduceMotion: reduceMotion
    )
  }
}

/// Per-frame lighting grade. Looks snap; this eases, so the room does not pop.
public struct StageLight: Equatable, Sendable {
  /// Accent fill strength, 0...1.
  public var glow: Double
  /// How wide the key light is, 0...1 (maps onto the panel radius).
  public var radius: Double
  /// Edge falloff, 0...1.
  public var vignette: Double
  /// Chorus camera, 0...1.
  public var anthem: Double
  /// Instrumental camera, 0...1.
  public var picture: Double
  /// Pre-vocal blackout, 0...1.
  public var breath: Double

  public init(
    glow: Double,
    radius: Double,
    vignette: Double,
    anthem: Double,
    picture: Double,
    breath: Double
  ) {
    self.glow = glow
    self.radius = radius
    self.vignette = vignette
    self.anthem = anthem
    self.picture = picture
    self.breath = breath
  }

  public static let document = StageLight(
    glow: 0.12, radius: 0.40, vignette: 0.56, anthem: 0, picture: 0, breath: 0
  )
  public static let anthem = StageLight(
    glow: 0.30, radius: 0.66, vignette: 0.32, anthem: 1, picture: 0, breath: 0
  )
  public static let picture = StageLight(
    glow: 0.36, radius: 0.88, vignette: 0.46, anthem: 0, picture: 1, breath: 0
  )
  public static let breath = StageLight(
    glow: 0.018, radius: 0.10, vignette: 0.88, anthem: 0, picture: 0, breath: 1
  )

  /// Discrete target for a look. Breath ramps with how far into the window we are
  /// so the blackout is clock-accurate instead of waiting on a filter.
  public static func target(for look: StageLook, nextVocalIn: Double?) -> StageLight {
    switch look {
    case .document: return .document
    case .anthem: return .anthem
    case .picture: return .picture
    case .breath:
      let u: Double
      if let eta = nextVocalIn, StageLookMath.breathWindow > 0 {
        u = min(1, max(0, (StageLookMath.breathWindow - eta) / 0.10))
      } else {
        u = 1
      }
      return StageLight(
        glow: 0.12 * (1 - u),
        radius: 0.40 * (1 - u) + 0.10 * u,
        vignette: 0.56 + 0.32 * u,
        anthem: 0,
        picture: 0,
        breath: u
      )
    }
  }

  /// Exponential ease toward `other`. `tau` is the time to ~63% of the remaining gap.
  public func movingToward(_ other: StageLight, dt: Double, tau: Double) -> StageLight {
    let a = 1 - exp(-max(0, dt) / max(0.001, tau))
    return StageLight(
      glow: glow + (other.glow - glow) * a,
      radius: radius + (other.radius - radius) * a,
      vignette: vignette + (other.vignette - vignette) * a,
      anthem: anthem + (other.anthem - anthem) * a,
      picture: picture + (other.picture - picture) * a,
      breath: breath + (other.breath - breath) * a
    )
  }
}
