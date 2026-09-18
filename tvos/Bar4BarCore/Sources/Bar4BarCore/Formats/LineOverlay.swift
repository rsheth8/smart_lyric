import Foundation

/// Timestamped LRC overlays (NetEase `romalrc`, translations) hung onto a timeline.
///
/// Port of `app/providers/formats/translation.js`: parse `[mm:ss.xx]text` rows and
/// attach each to the nearest sung line by start time, so a word-level yrc
/// timeline still lines up with a line-level romanization track.
public enum LineOverlay {
  public enum Field: String, Sendable {
    case roman
    case english
  }

  private static let stampRE = try! NSRegularExpression(
    pattern: #"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]"#
  )

  public static func parseLRC(_ lrc: String) -> [(start: Double, text: String)] {
    var out: [(start: Double, text: String)] = []
    for raw in lrc.split(whereSeparator: \.isNewline).map(String.init) {
      let ns = raw as NSString
      let full = NSRange(location: 0, length: ns.length)
      var stamps: [Double] = []
      var lastEnd = 0
      stampRE.enumerateMatches(in: raw, range: full) { match, _, _ in
        guard let match, match.numberOfRanges >= 3 else { return }
        let mm = Double(ns.substring(with: match.range(at: 1))) ?? 0
        let ss = Double(ns.substring(with: match.range(at: 2))) ?? 0
        var frac = 0.0
        if match.numberOfRanges >= 4, match.range(at: 3).location != NSNotFound {
          frac = Double("0.\(ns.substring(with: match.range(at: 3)))") ?? 0
        }
        stamps.append(mm * 60 + ss + frac)
        lastEnd = match.range.location + match.range.length
      }
      guard !stamps.isEmpty else { continue }
      let text = ns.substring(from: lastEnd).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      for start in stamps { out.append((start, text)) }
    }
    out.sort { $0.start < $1.start }
    return out
  }

  /// Attach overlay strings onto `timeline.lines` in place. Returns the match count.
  @discardableResult
  public static func attach(
    _ lrc: String,
    as field: Field,
    to timeline: inout Timeline,
    tolerance: Double = 3
  ) -> Int {
    let entries = parseLRC(lrc)
    guard !entries.isEmpty, !timeline.lines.isEmpty else { return 0 }

    var matched = 0
    var lines = timeline.lines
    for i in lines.indices {
      var best: (start: Double, text: String)?
      var bestDiff = Double.infinity
      for entry in entries {
        let d = abs(entry.start - lines[i].start)
        if d < bestDiff {
          bestDiff = d
          best = entry
        }
      }
      guard let best, bestDiff <= tolerance else { continue }
      let original = lines[i].text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !best.text.isEmpty, best.text != original else { continue }
      switch field {
      case .roman: lines[i].roman = best.text
      case .english: lines[i].english = best.text
      }
      matched += 1
    }
    timeline.lines = lines
    return matched
  }
}
