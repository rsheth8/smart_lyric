import Foundation

public enum Estimate {
  private static let naturalSyllPerSec = 4.0
  private static let stretchBlend = 0.3

  public static func syllableCount(_ word: String) -> Int {
    let w = word.lowercased()
    let latin = w.unicodeScalars.contains { CharacterSet.letters.contains($0) && $0.isASCII }
    if latin {
      let pattern = #"[aeiouyàáâäãåèéêëìíîïòóôöõùúûüỳýŷÿ]+"#
      let matches = w.ranges(of: pattern, options: .regularExpression)
      var n = matches.count
      if n > 1, w.range(of: #"[^aeiou]e\b"#, options: .regularExpression) != nil {
        n -= 1
      }
      return max(1, n)
    }
    let letters = w.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
    return max(1, letters)
  }

  public static func tokenizeLine(_ text: String) -> [String] {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)
      .filter { !$0.isEmpty }
  }

  /// Onset-pack words across [start, end) — port of `wordsAcrossSpan`.
  public static func wordsAcrossSpan(tokens: [String], start: Double, end: Double) -> [LyricWord] {
    let span = max(0.001, end - start)
    if tokens.isEmpty { return [] }
    if tokens.count == 1 {
      return [LyricWord(text: tokens[0], start: start, end: end)]
    }
    let weights = tokens.map { 0.4 + Double(syllableCount($0)) }
    let total = weights.reduce(0, +)
    let safeTotal = total > 0 ? total : 1

    let natural = weights.map { $0 / naturalSyllPerSec }
    let naturalTotal = natural.reduce(0, +)
    let scale = naturalTotal > span ? span / naturalTotal : 1.0

    var starts: [Double] = []
    var packedT = start
    var evenT = start
    for i in 0..<tokens.count {
      starts.append(packedT * (1 - stretchBlend) + evenT * stretchBlend)
      packedT += natural[i] * scale
      evenT += (weights[i] / safeTotal) * span
    }

    return tokens.enumerated().map { i, text in
      LyricWord(
        text: text,
        start: starts[i],
        end: i + 1 < starts.count ? starts[i + 1] : end
      )
    }
  }
}

private extension String {
  func ranges(of pattern: String, options: String.CompareOptions = []) -> [Range<String.Index>] {
    var result: [Range<String.Index>] = []
    var search = startIndex..<endIndex
    while let r = range(of: pattern, options: options, range: search) {
      result.append(r)
      search = r.upperBound..<endIndex
    }
    return result
  }
}

private extension UnicodeScalar {
  var isASCII: Bool { value < 128 }
}
