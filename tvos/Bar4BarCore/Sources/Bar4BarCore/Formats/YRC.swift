import Foundation

/// NetEase yrc word-level karaoke → canonical timeline.
public enum YRC {
  private static let lineRE = try! NSRegularExpression(pattern: #"^\[(\d+),(\d+)\]"#)
  private static let wordRE = try! NSRegularExpression(pattern: #"\((\d+),(\d+),\d+\)([^(\n]*)"#)

  public static func parse(_ yrc: String, trailingLineSeconds: Double = 4) -> Timeline {
    var lines: [LyricLine] = []
    for raw in yrc.split(whereSeparator: \.isNewline).map(String.init) {
      let ns = raw as NSString
      let full = NSRange(location: 0, length: ns.length)
      guard let header = lineRE.firstMatch(in: raw, range: full),
            header.numberOfRanges >= 3
      else { continue }

      var words: [LyricWord] = []
      wordRE.enumerateMatches(in: raw, range: full) { match, _, _ in
        guard let match, match.numberOfRanges >= 4 else { return }
        let start = (Double(ns.substring(with: match.range(at: 1))) ?? 0) / 1000
        let dur = (Double(ns.substring(with: match.range(at: 2))) ?? 0) / 1000
        let text = ns.substring(with: match.range(at: 3))
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        words.append(LyricWord(text: text, start: start, end: start + dur))
      }
      guard !words.isEmpty else { continue }

      let lineStart = (Double(ns.substring(with: header.range(at: 1))) ?? 0) / 1000
      let lineDur = (Double(ns.substring(with: header.range(at: 2))) ?? 0) / 1000
      let lineEnd = max(lineStart + lineDur, words.last!.end)
      lines.append(LyricLine(start: lineStart, end: lineEnd, words: words))
    }

    guard !lines.isEmpty else { return Timeline(lines: [], duration: 0) }


    return Timeline(lines: lines, duration: lines.last?.end ?? 0, source: "yrc")
  }
}
