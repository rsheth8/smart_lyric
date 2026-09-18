import Foundation

/// Clock-driven stage events that are not cameras. Hold, last chorus, density,
/// duet lane, entrance, afterglow, and seek targets — the view only renders
/// what this returns.
public enum StageDirection {
  public static let entranceWindow = 2.8
  public static let afterglowWindow = 8.0
  public static let cheerDuration = 1.35
  public static let chorusDropWindow = 1.8
  public static let wordImpactWindow = 0.30
  public static let denseMinWords = 6
  public static let denseMeanSec = 0.38

  // MARK: - Hold

  /// How much the currently sung word is a held note, 0...1.
  public static func activeHold(lines: [LyricLine], t: Double, activeLi: Int) -> Double {
    guard activeLi >= 0, activeLi < lines.count, t.isFinite else { return 0 }
    var best = 0.0
    for word in lines[activeLi].words where t >= word.start && t <= word.end {
      best = max(best, DisplayMath.holdAmount(word.end - word.start))
    }
    return best
  }

  /// A short lighting kick at the start of each sung word. This is deliberately
  /// derived from lyric timing rather than a fake BPM: the stage reacts to the
  /// performance we actually know, and never drifts away from the vocal.
  public static func wordImpact(
    lines: [LyricLine],
    t: Double,
    activeLi: Int,
    window: Double = wordImpactWindow
  ) -> Double {
    guard activeLi >= 0, activeLi < lines.count, t.isFinite, window > 0 else { return 0 }
    var impact = 0.0
    for word in lines[activeLi].words {
      let age = t - word.start
      guard age >= 0, age < window else { continue }
      let u = age / window
      // Fast attack, soft cinematic falloff.
      impact = max(impact, pow(1 - u, 2))
    }
    return impact
  }

  // MARK: - Last chorus

  public static func lastChorusIndex(_ sections: [Sections.Section]) -> Int? {
    sections.lastIndex { $0.part == .chorus }
  }

  /// True only on the final chorus of a song that already had one. A single
  /// chorus is just Anthem — finale is the reprise.
  public static func isFinale(sections: [Sections.Section], t: Double) -> Bool {
    guard t.isFinite else { return false }
    let choruses = sections.indices.filter { sections[$0].part == .chorus }
    guard choruses.count >= 2, let last = choruses.last else { return false }
    let section = sections[last]
    return t >= section.start && t < section.end
  }

  /// 1 on the cut into a chorus, fading to 0 over the title-card window.
  /// Instrumental section markers do not receive a drop.
  public static func chorusDrop(
    sections: [Sections.Section],
    t: Double,
    window: Double = chorusDropWindow
  ) -> Double {
    guard t.isFinite, window > 0,
          let index = Sections.index(in: sections, at: t),
          sections[index].part == .chorus else { return 0 }
    let age = t - sections[index].start
    guard age >= 0, age < window else { return 0 }
    let u = age / window
    return 1 - u * u * (3 - 2 * u)
  }

  public static func lastChorusLineIndex(_ lines: [LyricLine]) -> Int? {
    let flags = Sections.chorusFlags(lines)
    return flags.lastIndex(of: true)
  }

  // MARK: - Density

  /// Fast, wordy lines — rap and patter — that should pack into a grid
  /// instead of the ballad ladder. The last word is ignored so a pickup
  /// run into a held tail still counts as dense.
  public static func isDense(_ line: LyricLine) -> Bool {
    let words = line.words.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard words.count >= denseMinWords else { return false }
    let durs = words.map { max(0, $0.end - $0.start) }
    let body = durs.count > 1 ? Array(durs.dropLast()) : durs
    let mean = body.reduce(0, +) / Double(body.count)
    return mean <= denseMeanSec
  }

  // MARK: - Afterglow

  public struct Afterglow: Equatable, Sendable {
    public var lineIndex: Int
    /// 0 at the last lyric, 1 when the card should be gone.
    public var progress: Double
    /// Clock time that fills every word so the freeze is the finished line.
    public var freezeAt: Double
  }

  public static func afterglow(
    lines: [LyricLine],
    t: Double,
    duration: Double,
    window: Double = afterglowWindow
  ) -> Afterglow? {
    guard !lines.isEmpty, t.isFinite else { return nil }
    let lastEnd = lines[lines.count - 1].end
    guard t >= lastEnd else { return nil }
    let songEnd = duration > lastEnd ? duration : lastEnd + window
    let span = min(window, max(1.2, songEnd - lastEnd))
    guard t < lastEnd + span else { return nil }
    let idx = lastChorusLineIndex(lines) ?? (lines.count - 1)
    let line = lines[idx]
    return Afterglow(
      lineIndex: idx,
      progress: min(1, max(0, (t - lastEnd) / span)),
      freezeAt: line.end
    )
  }

  // MARK: - Entrance

  /// 1 at song start, 0 once the plate should be gone. Long intros keep the
  /// full card until vocals; songs that start singing immediately fade across
  /// `entranceWindow`.
  public static func entranceOpacity(
    t: Double,
    firstLineStart: Double?,
    window: Double = entranceWindow
  ) -> Double {
    guard t.isFinite, t >= 0 else { return 0 }
    let holdUntil: Double
    if let first = firstLineStart, first > window {
      holdUntil = first
    } else {
      holdUntil = window
    }
    if t >= holdUntil { return 0 }
    let fade = min(0.6, max(0.25, holdUntil * 0.3))
    let fadeStart = holdUntil - fade
    if t <= fadeStart { return 1 }
    return max(0, (holdUntil - t) / fade)
  }

  public static func entranceIsFullCard(firstLineStart: Double?, t: Double) -> Bool {
    guard let first = firstLineStart else { return t < entranceWindow }
    return first > 1.2 && t < first
  }

  // MARK: - Seek

  /// Next chorus after `t`, or the first hook if this was the last one.
  public static func nextChorusStart(
    sections: [Sections.Section],
    t: Double,
    skipAhead: Double = 0.45
  ) -> Double? {
    let choruses = sections.filter { $0.part == .chorus }
    guard !choruses.isEmpty else { return nil }
    if let next = choruses.first(where: { $0.start > t + skipAhead }) {
      return next.start
    }
    return choruses[0].start
  }

  public static func currentLineStart(lines: [LyricLine], t: Double, activeLi: Int) -> Double? {
    if activeLi >= 0, activeLi < lines.count {
      return lines[activeLi].start
    }
    let next = activeLi < 0 ? 0 : activeLi + 1
    guard next < lines.count else { return nil }
    return lines[next].start
  }

  // MARK: - Duet

  public enum Lane: String, Equatable, Sendable {
    case none
    case lead
    case room

    public var slug: String? {
      switch self {
      case .none: return nil
      case .lead: return "LEAD"
      case .room: return "ROOM"
      }
    }
  }

  public static func lane(for line: LyricLine) -> Lane {
    guard let agent = line.agent?.trimmingCharacters(in: .whitespacesAndNewlines),
          !agent.isEmpty else { return .none }
    return agent == "v1" ? .lead : .room
  }
}
