import Foundation

/// Minimal Apple TTML karaoke subset → timeline (word `<span begin end>`).
/// Full agent/song-part support can grow later; this covers the common wipe case.
public enum TTML {
  private static let spanRE = try! NSRegularExpression(
    pattern: #"<span[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([^<]*)</span>"#,
    options: [.caseInsensitive]
  )
  private static let pBeginRE = try! NSRegularExpression(
    pattern: #"<p[^>]*begin="([^"]+)""#,
    options: [.caseInsensitive]
  )

  public static func parse(_ xml: String, trailingLineSeconds: Double = 4) -> Timeline {
    // Split into <p>…</p> blocks when present; otherwise treat whole doc as one line set.
    let blocks = xml.components(separatedBy: "<p").dropFirst().map { "<p" + $0 }
    var lines: [LyricLine] = []

    if blocks.isEmpty {
      let words = parseSpans(xml)
      if !words.isEmpty {
        let start = words.first!.start
        let end = words.last!.end + trailingLineSeconds
        lines.append(LyricLine(start: start, end: end, words: words))
      }
    } else {
      for block in blocks {
        let words = parseSpans(block)
        guard !words.isEmpty else { continue }
        var start = words.first!.start
        if let m = pBeginRE.firstMatch(in: block, range: NSRange(location: 0, length: (block as NSString).length)) {
          let s = (block as NSString).substring(with: m.range(at: 1))
          start = parseClock(s) ?? start
        }
        let end = words.last!.end
        lines.append(LyricLine(start: start, end: end, words: words))
      }
    }

    guard !lines.isEmpty else { return Timeline(lines: [], duration: 0) }
    for i in 0..<(lines.count - 1) {
      if lines[i].end > lines[i + 1].start {
        lines[i].end = lines[i + 1].start
      }
    }
    if let last = lines.indices.last {
      lines[last].end = max(lines[last].end, lines[last].words.last?.end ?? lines[last].end)
    }
    return Timeline(lines: lines, duration: lines.last?.end ?? 0, source: "ttml")
  }

  private static func parseSpans(_ xml: String) -> [LyricWord] {
    var words: [LyricWord] = []
    let ns = xml as NSString
    spanRE.enumerateMatches(in: xml, range: NSRange(location: 0, length: ns.length)) { match, _, _ in
      guard let match, match.numberOfRanges >= 4 else { return }
      let begin = parseClock(ns.substring(with: match.range(at: 1))) ?? 0
      let end = parseClock(ns.substring(with: match.range(at: 2))) ?? begin
      let text = ns.substring(with: match.range(at: 3))
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { return }
      words.append(LyricWord(text: text, start: begin, end: end))
    }
    return words
  }

  /// TTML clock: `SS.mmm`, `MM:SS.mmm`, or `HH:MM:SS.mmm`.
  public static func parseClock(_ s: String) -> Double? {
    let parts = s.split(separator: ":").map(String.init)
    if parts.count == 1 { return Double(parts[0]) }
    if parts.count == 2 {
      guard let m = Double(parts[0]), let sec = Double(parts[1]) else { return nil }
      return m * 60 + sec
    }
    if parts.count == 3 {
      guard let h = Double(parts[0]), let m = Double(parts[1]), let sec = Double(parts[2]) else { return nil }
      return h * 3600 + m * 60 + sec
    }
    return nil
  }
}
