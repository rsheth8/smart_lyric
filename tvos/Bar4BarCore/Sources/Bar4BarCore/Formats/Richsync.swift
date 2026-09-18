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

    var estimated = false
    let lines: [LyricLine] = entries.enumerated().map { i, e in
      let start = e.ts
      let next = i + 1 < entries.count ? entries[i + 1] : nil
      let end = e.te ?? next?.ts ?? (start + trailingLineSeconds)

      var words: [LyricWord] = []
      for chunk in e.l ?? [] {
        guard let offset = chunk.o else { estimated = true; continue }
        let text = (chunk.c ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        words.append(LyricWord(text: text, start: start + offset, end: start, timingQuality: .reliable))
      }
      if words.isEmpty {
        estimated = true
        let text = (e.x ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        words = Estimate.wordsAcrossSpan(tokens: Estimate.tokenizeLine(text), start: start, end: end)
      } else {
        for k in 0..<words.count {
          words[k].end = k + 1 < words.count ? words[k + 1].start : end
        }
      }

      return LyricLine(start: start, end: end, words: words)
    }

    return Timeline(lines: lines, duration: lines.last?.end ?? 0, estimated: estimated, source: "richsync")
  }

}
