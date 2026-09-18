import Foundation

public enum LRC {
  private static let lineRE = try! NSRegularExpression(
    pattern: #"^((?:\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\])+)(.*)$"#
  )
  private static let tagRE = try! NSRegularExpression(
    pattern: #"\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]"#
  )
  private static let wordTsRE = try! NSRegularExpression(
    pattern: #"<(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)>"#
  )

  private static func toSeconds(mm: String, ss: String) -> Double {
    (Double(mm) ?? 0) * 60 + (Double(ss) ?? 0)
  }

  private struct RawLine {
    var start: Double
    var text: String
    var wordTimes: [Double]?
  }

  public static func parse(_ lrc: String, trailingLineSeconds: Double = 4) -> Timeline {
    let rawLines = parseRawLines(lrc).filter { !$0.text.isEmpty }
    guard !rawLines.isEmpty else { return Timeline(lines: [], duration: 0) }

    var estimated = false
    let lines: [LyricLine] = rawLines.enumerated().map { i, line in
      let next = i + 1 < rawLines.count ? rawLines[i + 1] : nil
      let end = next?.start ?? (line.start + trailingLineSeconds)
      let tokens = Estimate.tokenizeLine(line.text)
      let words: [LyricWord]
      if let times = line.wordTimes, times.count == tokens.count {
        words = tokens.enumerated().map { wi, text in
          LyricWord(
            text: text,
            start: times[wi],
            end: wi + 1 < times.count ? times[wi + 1] : end,
            timingQuality: .reliable
          )
        }
      } else {
        estimated = true
        words = Estimate.wordsAcrossSpan(tokens: tokens, start: line.start, end: end)
      }
      return LyricLine(start: line.start, end: end, words: words)
    }

    return Timeline(lines: lines, duration: lines.last?.end ?? 0, estimated: estimated, source: estimated ? "lrc" : "elrc")
  }

  private static func parseRawLines(_ lrc: String) -> [RawLine] {
    var out: [RawLine] = []
    for raw in lrc.split(whereSeparator: \.isNewline).map(String.init) {
      let ns = raw as NSString
      let full = NSRange(location: 0, length: ns.length)
      guard let m = lineRE.firstMatch(in: raw, range: full),
            m.numberOfRanges >= 3
      else { continue }
      let stamps = ns.substring(with: m.range(at: 1))
      let body = ns.substring(with: m.range(at: 2))

      var starts: [Double] = []
      tagRE.enumerateMatches(in: stamps, range: NSRange(location: 0, length: (stamps as NSString).length)) { match, _, _ in
        guard let match, match.numberOfRanges >= 3 else { return }
        let s = stamps as NSString
        starts.append(toSeconds(mm: s.substring(with: match.range(at: 1)), ss: s.substring(with: match.range(at: 2))))
      }

      let text = wordTsRE.stringByReplacingMatches(
        in: body,
        range: NSRange(location: 0, length: (body as NSString).length),
        withTemplate: ""
      ).trimmingCharacters(in: .whitespacesAndNewlines)

      let wordTimes = extractWordTimes(body)
      for start in starts {
        out.append(RawLine(
          start: start,
          text: text,
          wordTimes: wordTimes.isEmpty ? nil : wordTimes
        ))
      }
    }
    out.sort { $0.start < $1.start }
    return out
  }

  private static func extractWordTimes(_ body: String) -> [Double] {
    var times: [Double] = []
    let ns = body as NSString
    wordTsRE.enumerateMatches(in: body, range: NSRange(location: 0, length: ns.length)) { match, _, _ in
      guard let match, match.numberOfRanges >= 3 else { return }
      times.append(toSeconds(
        mm: ns.substring(with: match.range(at: 1)),
        ss: ns.substring(with: match.range(at: 2))
      ))
    }
    return times
  }
}
