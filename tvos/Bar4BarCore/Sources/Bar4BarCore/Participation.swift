import Foundation

/// Explicit participation choices. Lyric metadata never assigns a person to sing.
public enum ParticipationMode: String, CaseIterable, Sendable {
  case solo = "Solo"
  case duo = "Take turns"
  case everyone = "Everyone"

  public init(savedValue: String) {
    self = Self(rawValue: savedValue) ?? .solo
  }
}

public enum SingerSide: String, Equatable, Sendable {
  case a = "SIDE A"
  case b = "SIDE B"
}

/// Stable for a lyric revision: timing corrections and seeking cannot reshuffle turns.
public enum Participation {
  public static func isSingable(_ line: LyricLine) -> Bool {
    line.words.contains { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  public static func side(at index: Int, in timeline: Timeline) -> SingerSide? {
    guard timeline.lines.indices.contains(index), isSingable(timeline.lines[index]) else { return nil }
    let turn = timeline.lines[..<index].reduce(0) { $0 + (isSingable($1) ? 1 : 0) }
    return turn.isMultiple(of: 2) ? .a : .b
  }

  public static func nextSingableLine(after index: Int, in timeline: Timeline) -> Int? {
    let start = max(0, index + 1)
    guard start < timeline.lines.count else { return nil }
    return (start..<timeline.lines.count).first { isSingable(timeline.lines[$0]) }
  }
}
