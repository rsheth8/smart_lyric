import Foundation

/// Musixmatch richsync → canonical timeline.
public enum Richsync {
  private struct Entry: Decodable {
    var ts: Double
    var te: Double?
    var x: String?
    var l: [Chunk]?
  }

  private struct Chunk: Decodable {
    var c: String?
    var o: Double?
  }

  public static func parse(_ body: String, trailingLineSeconds: Double = 4) -> Timeline {
    guard let data = body.data(using: .utf8),
          var entries = try? JSONDecoder().decode([Entry].self, from: data),
          !entries.isEmpty
    else {
      return Timeline(lines: [], duration: 0)
    }
    entries.sort { $0.ts < $1.ts }

    let lines: [LyricLine] = entries.enumerated().map { i, e in
      let start = e.ts
      let next = i + 1 < entries.count ? entries[i + 1] : nil
      let end = next?.ts ?? max(e.te ?? start, start + trailingLineSeconds)

      var words: [LyricWord] = []
      for chunk in e.l ?? [] {
        let text = (chunk.c ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        words.append(LyricWord(text: text, start: start + (chunk.o ?? 0), end: start))
      }
      if words.isEmpty {
        let text = (e.x ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        words = [LyricWord(text: text, start: start, end: end)]
      } else {
        for k in 0..<words.count {
          words[k].end = k + 1 < words.count ? words[k + 1].start : end
        }
      }

      let maxOffset = words.last!.start - start
      let span = end - start
      if words.count > 1, span > 1.5, maxOffset < 0.4 * span {
        words = interpolateBySyllable(words, start: start, end: end)
      }

      return LyricLine(start: start, end: end, words: words)
    }

    return Timeline(lines: lines, duration: lines.last?.end ?? 0, source: "richsync")
  }

  private static func interpolateBySyllable(
    _ words: [LyricWord],
    start: Double,
    end: Double
  ) -> [LyricWord] {
    let span = max(0.001, end - start)
    let weights = words.map { 0.4 + Double(Estimate.syllableCount($0.text)) }
    let total = weights.reduce(0, +)
    let safe = total > 0 ? total : 1
    var t = start
    return words.enumerated().map { i, w in
      let dur = (weights[i] / safe) * span
      let out = LyricWord(text: w.text, start: t, end: t + dur)
      t += dur
      return out
    }
  }
}
