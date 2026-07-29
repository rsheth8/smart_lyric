import Foundation

/// Song structure — verse / chorus / instrumental break.
///
/// Swift port of `app/providers/formats/sections.js`. Apple gets this for free
/// (`itunes:song-part` is authored into their TTML); we almost never have it, so
/// structure is DERIVED from the two signals a lyric timeline already carries:
///
///   1. Long gaps between sung lines → instrumental breaks, plus intro/outro.
///   2. Repeated blocks of text → the chorus. A block sung more than once is a
///      chorus in essentially every popular song; one sung once is a verse.
///
/// Deliberately no "Bridge", "Pre-Chorus", or verse numbering: repetition
/// supports chorus-vs-verse and nothing finer, and a confident wrong label is
/// worse than a vague right one.
public enum Sections {

  public struct Section: Equatable, Sendable {
    public let part: Part
    public let start: Double
    public let end: Double
    /// False only for structure the lyric provider authored.
    public let derived: Bool

    public init(part: Part, start: Double, end: Double, derived: Bool = true) {
      self.part = part
      self.start = start
      self.end = end
      self.derived = derived
    }

    public var duration: Double { end - start }
  }

  public enum Part: String, Equatable, Sendable {
    case intro = "Intro"
    case verse = "Verse"
    case chorus = "Chorus"
    case brk = "Break"
    case outro = "Outro"

    /// True for passages with no words — the rail draws these differently
    /// because they are the moments a singer is waiting rather than reading.
    public var isInstrumental: Bool { self == .intro || self == .brk || self == .outro }
  }

  /// Silence between sung lines that reads as a block boundary.
  static let blockGapSec: Double = 3.2
  /// Gap long enough to be its own instrumental section on the rail.
  static let breakGapSec: Double = 8
  /// Lead-in / run-out worth showing as Intro / Outro.
  static let edgeSec: Double = 5
  /// Shorter than this isn't a section, it's a stray line.
  static let minSectionSec: Double = 6
  /// A repeated line must be substantial — "oh" and "yeah" recur everywhere.
  static let minHookChars = 8
  /// A chorus is a repeated PASSAGE; one recurring line is a refrain.
  static let minChorusLines = 2

  // MARK: - Text keys

  static func normalize(_ s: String) -> String {
    let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
    let stripped = folded.map { ch -> Character in
      ch.isLetter || ch.isNumber ? ch : " "
    }
    return String(stripped).split(separator: " ").joined(separator: " ")
  }

  static func lineKey(_ line: LyricLine) -> String {
    normalize(line.words.map(\.text).joined(separator: " "))
  }

  /// Where the voice actually stops. Catalog LRC has no true line end — it
  /// borrows the next line's start — so a boundary measured from `line.end`
  /// would swallow every gap in the song.
  static func sungUntil(_ line: LyricLine, maxHold: Double = 2.0) -> Double {
    guard let last = line.words.last else { return line.start }
    return min(last.end, last.start + maxHold)
  }

  // MARK: - Chorus detection

  /// Per-line "this is chorus material" flags.
  public static func chorusFlags(_ lines: [LyricLine]) -> [Bool] {
    let keys = lines.map(lineKey)
    var counts: [String: Int] = [:]
    for k in keys where k.count >= minHookChars {
      counts[k, default: 0] += 1
    }

    // A line is chorus material when its text recurs...
    let repeated = keys.map { $0.count >= minHookChars && (counts[$0] ?? 0) > 1 }

    // ...and it sits in a RUN of such lines. An isolated recurring line is a
    // refrain inside a verse, not a chorus of its own.
    var flags = [Bool](repeating: false, count: lines.count)
    var i = 0
    while i < lines.count {
      guard repeated[i] else { i += 1; continue }
      var j = i
      while j < lines.count && repeated[j] { j += 1 }
      if j - i >= minChorusLines {
        for k in i..<j { flags[k] = true }
      }
      i = j
    }
    return flags
  }

  // MARK: - Derivation

  private struct Span {
    var part: Part
    var start: Double
    var end: Double
  }

  /// Absorb sections too short to be real. A two-second "Verse" wedged between
  /// two choruses is a lyric sheet's stray line, not a change of section — and
  /// on a rail it renders as noise a viewer cannot act on.
  private static func smoothSlivers(_ spans: inout [Span]) {
    var i = spans.count - 1
    while i >= 0 {
      defer { i -= 1 }
      if spans.count < 2 { break }
      guard i < spans.count else { continue }
      let span = spans[i]
      if span.end - span.start >= minSectionSec { continue }

      // Only ever merge into a neighbour the sliver actually touches. A short
      // block on the far side of a guitar solo is a real section, however
      // brief — absorbing it across the gap would erase the break with it.
      let prevIdx = i - 1
      let nextIdx = i + 1
      let prevAdj = prevIdx >= 0 && span.start - spans[prevIdx].end < breakGapSec ? prevIdx : nil
      let nextAdj = nextIdx < spans.count && spans[nextIdx].start - span.end < breakGapSec ? nextIdx : nil

      // Prefer a same-labelled neighbour; otherwise the earlier one.
      let target: Int?
      if let p = prevAdj, nextAdj == nil || spans[nextAdj!].part != span.part {
        target = p
      } else {
        target = nextAdj
      }
      guard let t = target else { continue }
      spans[t].start = min(spans[t].start, span.start)
      spans[t].end = max(spans[t].end, span.end)
      spans.remove(at: i)
    }

    // Absorbing a sliver can leave two same-labelled neighbours abutting.
    var j = spans.count - 1
    while j > 0 {
      defer { j -= 1 }
      guard j < spans.count else { continue }
      if spans[j - 1].part != spans[j].part { continue }
      if spans[j].start - spans[j - 1].end >= breakGapSec { continue }  // a real gap divides them
      spans[j - 1].end = max(spans[j - 1].end, spans[j].end)
      spans.remove(at: j)
    }
  }

  /// Contiguous sections covering the song, so a rail can render them end to end.
  public static func derive(_ timeline: Timeline) -> [Section] {
    let lines = timeline.lines.filter { !$0.words.isEmpty }
    // Too short to have structure worth showing.
    guard lines.count >= 4 else { return [] }

    let chorus = chorusFlags(lines)

    // Walk the lines, cutting a new section when the label changes or a real
    // instrumental gap separates them.
    var spans: [Span] = []
    for i in lines.indices {
      let part: Part = chorus[i] ? .chorus : .verse
      let gapFromPrev = spans.last.map { lines[i].start - $0.end } ?? 0
      if var prev = spans.last, prev.part == part, gapFromPrev < breakGapSec {
        prev.end = sungUntil(lines[i])
        spans[spans.count - 1] = prev
      } else {
        spans.append(Span(part: part, start: lines[i].start, end: sungUntil(lines[i])))
      }
    }
    smoothSlivers(&spans)
    // One undifferentiated block — nothing to show.
    guard spans.count >= 2 else { return [] }

    let duration = timeline.duration > 0 ? timeline.duration : spans[spans.count - 1].end

    var out: [Section] = []
    func push(_ part: Part, _ start: Double, _ end: Double) {
      guard end - start > 0.01 else { return }
      out.append(Section(part: part, start: start, end: end))
    }

    if spans[0].start >= edgeSec { push(.intro, 0, spans[0].start) }
    for i in spans.indices {
      let next = i + 1 < spans.count ? spans[i + 1] : nil
      let gap = next.map { $0.start - spans[i].end } ?? 0
      // Breathing room between two adjacent sections belongs to the earlier
      // one. Leaving it as a hole makes the rail look broken and blanks the
      // label every time the playhead crosses a crack.
      let end = (next != nil && gap < breakGapSec) ? next!.start : spans[i].end
      push(spans[i].part, spans[i].start, end)
      if let next, gap >= breakGapSec { push(.brk, spans[i].end, next.start) }
    }
    let lastEnd = spans[spans.count - 1].end
    if duration - lastEnd >= edgeSec { push(.outro, lastEnd, duration) }

    return out
  }

  /// Index of the section containing `t`, or nil. Sections are ordered and
  /// non-overlapping, so a scan from a hint is effectively O(1) per frame.
  public static func index(in sections: [Section], at t: Double, hint: Int = 0) -> Int? {
    guard !sections.isEmpty, t.isFinite else { return nil }
    let start = max(0, min(hint, sections.count - 1))
    if t >= sections[start].start && t < sections[start].end { return start }
    for i in sections.indices where t >= sections[i].start && t < sections[i].end {
      return i
    }
    return nil
  }
}
