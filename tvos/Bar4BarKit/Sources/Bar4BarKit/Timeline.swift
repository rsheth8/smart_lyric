// Lyric timelines: the same canonical shape as the web app (app/providers/formats)
// — lines of words, each with start/end seconds — and the parsers that build them.

import Foundation

public struct Word: Equatable, Sendable {
  public var text: String
  public var start: Double
  public var end: Double

  public init(text: String, start: Double, end: Double) {
    self.text = text
    self.start = start
    self.end = end
  }
}

public struct Line: Equatable, Sendable {
  public var start: Double
  public var end: Double
  public var words: [Word]

  public init(start: Double, end: Double, words: [Word]) {
    self.start = start
    self.end = end
    self.words = words
  }

  public var text: String { words.map(\.text).joined(separator: " ") }
}

public struct Timeline: Equatable, Sendable {
  public var lines: [Line]
  /// True when every word carries real sung timing (NetEase yrc), not an estimate.
  public var wordSync: Bool

  public init(lines: [Line], wordSync: Bool = false) {
    self.lines = lines
    self.wordSync = wordSync
  }

  public var duration: Double { lines.last?.end ?? 0 }

  /// Index of the line being sung at `t`: the last one that has started, -1 before the first.
  public func activeLine(at t: Double) -> Int {
    var active = -1
    for (i, line) in lines.enumerated() {
      guard t >= line.start else { break }
      active = i
    }
    return active
  }

  /// Past the last line plus an outro grace (app/companion.js songFinished).
  public func isFinished(at t: Double, grace: Double = 6) -> Bool {
    !lines.isEmpty && t > duration + grace
  }

  /// Seconds until the next line while the stage is quiet — the intro, or a real
  /// instrumental gap — so the singer gets a count-in. nil when none should show.
  public func countIn(at t: Double, window: Double = 3, minGap: Double = 4) -> Double? {
    let active = activeLine(at: t)
    let next = active + 1
    guard next < lines.count else { return nil }
    let until = lines[next].start - t
    guard until > 0, until <= window else { return nil }
    if active >= 0 {
      if t < lines[active].end - 0.12 { return nil } // still mid-phrase
      if lines[next].start - lines[active].end < minGap { return nil }
    }
    return until
  }
}

/// 0…1 through a word's sung span (display.js wipeProgress).
public func wipeProgress(_ t: Double, _ start: Double, _ end: Double) -> Double {
  let dur = end - start
  guard dur > 0 else { return t >= end ? 1 : 0 }
  return min(1, max(0, (t - start) / dur))
}

// MARK: - Word timing estimates

private let silentE = NSRegularExpression("[^aeiou]e\\b")
private let vowels = Set("aeiouyàáâäãåèéêëìíîïòóôöõùúûüỳýŷÿ")

/// Rough syllable count — vowel groups for Latin text, letters for other scripts.
public func syllableCount(_ word: String) -> Int {
  let w = word.lowercased()
  if w.unicodeScalars.contains(where: { $0.value >= 97 && $0.value <= 122 }) {
    var n = 0
    var inGroup = false
    for c in w {
      let isVowel = vowels.contains(c)
      if isVowel && !inGroup { n += 1 }
      inGroup = isVowel
    }
    if n > 1, silentE.matches(w) { n -= 1 }
    return max(1, n)
  }
  return max(1, w.filter(\.isLetter).count)
}

// Tuned against real word timing in app/providers/formats/estimate.js.
private let naturalSyllablesPerSec = 4.0
private let stretchBlend = 0.3

/// Estimate word timing across a line: packed at a natural sung pace, with the
/// last word holding to the line end.
public func wordsAcrossSpan(_ tokens: [String], _ start: Double, _ end: Double) -> [Word] {
  let span = max(0.001, end - start)
  if tokens.isEmpty { return [] }
  if tokens.count == 1 { return [Word(text: tokens[0], start: start, end: end)] }
  let weights = tokens.map { 0.4 + Double(syllableCount($0)) }
  let total = weights.reduce(0, +)
  let natural = weights.map { $0 / naturalSyllablesPerSec }
  let naturalTotal = natural.reduce(0, +)
  let scale = naturalTotal > span ? span / naturalTotal : 1

  var starts: [Double] = []
  var packed = start
  var even = start
  for i in tokens.indices {
    starts.append(packed * (1 - stretchBlend) + even * stretchBlend)
    packed += natural[i] * scale
    even += weights[i] / total * span
  }
  return tokens.indices.map { i in
    Word(text: tokens[i], start: starts[i], end: i + 1 < starts.count ? starts[i + 1] : end)
  }
}

func tokenize(_ text: String) -> [String] {
  text.split(whereSeparator: \.isWhitespace).map(String.init)
}

// MARK: - NetEase yrc (word-level)

private let yrcLine = NSRegularExpression("^\\[(\\d+),(\\d+)\\]")
private let yrcWord = NSRegularExpression("\\((\\d+),(\\d+),\\d+\\)([^(\\n]*)")

/// `[lineStartMs,lineDurMs](wStartMs,wDurMs,0)Word (…)next …` → timeline.
public func parseYRC(_ yrc: String, trailingLineSeconds: Double = 4) -> Timeline {
  var lines: [Line] = []
  for raw in yrc.components(separatedBy: .newlines) {
    guard let header = yrcLine.groups(in: raw).first else { continue }
    let words: [Word] = yrcWord.groups(in: raw).compactMap { m in
      let text = m[3].trimmingCharacters(in: .whitespaces)
      guard !text.isEmpty else { return nil }
      let start = Double(m[1])! / 1000
      return Word(text: text, start: start, end: start + Double(m[2])! / 1000)
    }
    guard let last = words.last else { continue }
    let lineStart = Double(header[1])! / 1000
    let lineEnd = max(lineStart + Double(header[2])! / 1000, last.end)
    lines.append(Line(start: lineStart, end: lineEnd, words: words))
  }

  // Hold each word until the next begins, and each line until the next starts.
  for i in lines.indices {
    for j in lines[i].words.indices.dropLast() where lines[i].words[j].end < lines[i].words[j + 1].start {
      lines[i].words[j].end = lines[i].words[j + 1].start
    }
    let lastIndex = lines[i].words.count - 1
    lines[i].end = i + 1 < lines.count
      ? min(lines[i].end, lines[i + 1].start)
      : lines[i].words[lastIndex].end + trailingLineSeconds
    if lines[i].words[lastIndex].end < lines[i].end { lines[i].words[lastIndex].end = lines[i].end }
  }
  return Timeline(lines: lines, wordSync: true)
}

// MARK: - LRC (line-level)

private let lrcLine = NSRegularExpression("^((?:\\[\\d{1,2}:\\d{1,2}(?:\\.\\d{1,3})?\\])+)(.*)$")
private let lrcTag = NSRegularExpression("\\[(\\d{1,2}):(\\d{1,2}(?:\\.\\d{1,3})?)\\]")
private let lrcWordStamp = NSRegularExpression("<(\\d{1,2}):(\\d{1,2}(?:\\.\\d{1,3})?)>")

public func parseLRC(_ lrc: String, trailingLineSeconds: Double = 4) -> Timeline {
  struct Raw { var start: Double; var text: String; var wordTimes: [Double]; var order: Int }
  var raws: [Raw] = []
  for rawLine in lrc.components(separatedBy: .newlines) {
    guard let m = lrcLine.groups(in: rawLine).first else { continue }
    let body = m[2]
    let text = lrcWordStamp.replace(in: body, with: "").trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { continue }
    let wordTimes = lrcWordStamp.groups(in: body).map { Double($0[1])! * 60 + Double($0[2])! }
    for tag in lrcTag.groups(in: m[1]) {
      raws.append(Raw(start: Double(tag[1])! * 60 + Double(tag[2])!, text: text, wordTimes: wordTimes, order: raws.count))
    }
  }
  raws.sort { ($0.start, $0.order) < ($1.start, $1.order) }

  let lines = raws.indices.map { i -> Line in
    let raw = raws[i]
    let end = i + 1 < raws.count ? raws[i + 1].start : raw.start + trailingLineSeconds
    let tokens = tokenize(raw.text)
    let words = raw.wordTimes.count == tokens.count
      ? tokens.indices.map { Word(text: tokens[$0], start: raw.wordTimes[$0], end: $0 + 1 < tokens.count ? raw.wordTimes[$0 + 1] : end) }
      : wordsAcrossSpan(tokens, raw.start, end)
    return Line(start: raw.start, end: end, words: words)
  }
  return Timeline(lines: lines)
}

/// Untimed lyrics spread across the song so they still scroll (estimate.js).
public func estimateTimeline(_ plain: String, duration: Double?, secondsPerLine: Double = 3.4) -> Timeline {
  let sung = plain.components(separatedBy: .newlines)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
  guard !sung.isEmpty else { return Timeline(lines: []) }
  let span = (duration ?? 0) > 1 ? duration! : Double(sung.count) * secondsPerLine
  let per = span / Double(sung.count)
  return Timeline(lines: sung.indices.map { i in
    let start = Double(i) * per
    return Line(start: start, end: start + per, words: wordsAcrossSpan(tokenize(sung[i]), start, start + per))
  })
}

// MARK: - Regex helpers

extension NSRegularExpression {
  convenience init(_ pattern: String, options: Options = []) {
    try! self.init(pattern: pattern, options: options)
  }

  /// Every match, as [whole, group1, group2, …] ("" for a group that didn't take part).
  func groups(in s: String) -> [[String]] {
    let ns = s as NSString
    return matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
      (0..<m.numberOfRanges).map { i in
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : ns.substring(with: r)
      }
    }
  }

  func matches(_ s: String) -> Bool {
    firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
  }

  func replace(in s: String, with template: String) -> String {
    stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
  }
}
