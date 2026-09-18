import Foundation

/// Pronunciation / English overlay, matching the desktop language aid (`T`).
public enum LanguageAidMode: String, Sendable, CaseIterable {
  case off
  case roman
  case english

  public var label: String {
    switch self {
    case .off: return "Lyrics only"
    case .roman: return "Pronunciation"
    case .english: return "English"
    }
  }

  /// Tiny slug above the cinema plate. Nil when the original line stands alone.
  public var plateKind: String? {
    switch self {
    case .off: return nil
    case .roman: return "SAY"
    case .english: return "MEANING"
    }
  }

  /// Off → Pronunciation (when it applies) → English → Off.
  public static func next(from current: LanguageAidMode, romanApplies: Bool) -> LanguageAidMode {
    var order: [LanguageAidMode] = [.off]
    if romanApplies { order.append(.roman) }
    order.append(.english)
    let idx = order.firstIndex(of: current) ?? 0
    return order[(idx + 1) % order.count]
  }
}

/// Script detection, romanization cleanup, Google `translate_a` parsing, and an
/// on-device ICU fallback. Network I/O lives in `LanguageAidClient`.
public enum LanguageAid {
  public static let maxChars = 1400

  /// True when the lyrics are mostly a non-Latin script, so pronunciation helps.
  /// Mirrors `needsRomanization` in `app/providers/translate.js`.
  public static func needsRomanization(_ lines: [String]) -> Bool {
    nonLatinLetterCount(lines.joined(separator: " ")) > 3
  }

  public static func cleanRoman(_ s: String) -> String {
    let decomposed = s.decomposedStringWithCanonicalMapping
    let noMarks = String(decomposed.unicodeScalars.filter { !isCombiningMark($0) })
    return noMarks
      .replacingOccurrences(of: "’", with: "'")
      .replacingOccurrences(of: "ʼ", with: "'")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// On-device Latin transliteration when the catalog overlay and Google are absent.
  public static func localRomanize(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, needsRomanization([trimmed]) else { return nil }
    let latin = trimmed.applyingTransform(.toLatin, reverse: false) ?? trimmed
    let cleaned = cleanRoman(latin)
    guard !cleaned.isEmpty, cleaned != trimmed else { return nil }
    return cleaned
  }

  public static func chunkLines(_ lines: [String], maxChars: Int = maxChars) -> [[String]] {
    var chunks: [[String]] = []
    var cur: [String] = []
    var len = 0
    for line in lines {
      if len + line.count + 1 > maxChars, !cur.isEmpty {
        chunks.append(cur)
        cur = []
        len = 0
      }
      cur.append(line)
      len += line.count + 1
    }
    if !cur.isEmpty { chunks.append(cur) }
    return chunks
  }

  /// `data[0] = [[translated, original, …], …]` joined into one string.
  public static func extractTranslation(from json: Any) -> String {
    guard let root = json as? [Any], let segs = root.first as? [Any] else { return "" }
    return segs.compactMap { seg -> String? in
      guard let arr = seg as? [Any] else { return nil }
      return arr.first as? String
    }.joined()
  }

  /// `dt=rm` trailing segment is `[null, null, null, "<romanization>"]`.
  public static func extractRomanization(from json: Any) -> String {
    guard let root = json as? [Any], let segs = root.first as? [Any] else { return "" }
    for seg in segs {
      guard let arr = seg as? [Any], arr.count > 3 else { continue }
      let firstIsEmpty = arr[0] is NSNull || (arr[0] as? String) == nil
      guard firstIsEmpty, let roman = arr[3] as? String else { continue }
      return cleanRoman(roman)
    }
    return ""
  }

  public static func realign(_ extracted: String, to chunk: [String]) -> [String] {
    let parts = extracted.split(separator: "\n", omittingEmptySubsequences: false).map {
      String($0).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return chunk.indices.map { i in i < parts.count ? parts[i] : "" }
  }

  // MARK: - Script

  static func nonLatinLetterCount(_ text: String) -> Int {
    text.unicodeScalars.reduce(0) { $0 + (isNonLatinLetter($1) ? 1 : 0) }
  }

  /// Letter that isn't Latin (CJK, Hangul, Devanagari, Arabic, Cyrillic, …).
  static func isNonLatinLetter(_ s: Unicode.Scalar) -> Bool {
    let v = s.value
    if v <= 0x02AF { return false }
    if (0x1E00...0x1EFF).contains(v) { return false }
    if CharacterSet.punctuationCharacters.contains(s) { return false }
    if CharacterSet.whitespacesAndNewlines.contains(s) { return false }
    if CharacterSet.decimalDigits.contains(s) { return false }
    if CharacterSet.nonBaseCharacters.contains(s) { return false }
    if CharacterSet.controlCharacters.contains(s) { return false }
    return CharacterSet.letters.contains(s)
  }

  private static func isCombiningMark(_ s: Unicode.Scalar) -> Bool {
    (0x0300...0x036F).contains(s.value)
  }
}

/// Fetches English meaning and Latin pronunciation via the same Google endpoint
/// the desktop renderer uses (`translate.googleapis.com`, `client=gtx`).
public struct LanguageAidClient: LanguageAiding, Sendable {
  public var session: URLSession
  public var timeout: TimeInterval

  public init(session: URLSession = .shared, timeout: TimeInterval = 12) {
    self.session = session
    self.timeout = timeout
  }

  public func translateLines(_ lines: [String], to: String = "en") async -> [String]? {
    await mapChunks(lines, extract: { LanguageAid.extractTranslation(from: $0) }, to: to, romanize: false)
  }

  public func romanizeLines(_ lines: [String]) async -> [String]? {
    await mapChunks(lines, extract: { LanguageAid.extractRomanization(from: $0) }, to: "en", romanize: true)
  }

  private func mapChunks(
    _ lines: [String],
    extract: (Any) -> String,
    to: String,
    romanize: Bool
  ) async -> [String]? {
    let src = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard src.contains(where: { !$0.isEmpty }) else { return nil }
    var out: [String] = []
    do {
      for chunk in LanguageAid.chunkLines(src) {
        let json = try await callGTX(chunk.joined(separator: "\n"), to: to, romanize: romanize)
        out += LanguageAid.realign(extract(json), to: chunk)
      }
      return out
    } catch {
      return nil
    }
  }

  private func callGTX(_ text: String, to: String, romanize: Bool) async throws -> Any {
    var comps = URLComponents(string: "https://translate.googleapis.com/translate_a/single")
    comps?.queryItems = [
      URLQueryItem(name: "client", value: "gtx"),
      URLQueryItem(name: "sl", value: "auto"),
      URLQueryItem(name: "tl", value: to),
      URLQueryItem(name: "dt", value: romanize ? "rm" : "t"),
      URLQueryItem(name: "q", value: text),
    ]
    guard let url = comps?.url else { throw URLError(.badURL) }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      forHTTPHeaderField: "User-Agent"
    )
    let (data, response) = try await session.data(for: req)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw URLError(.badServerResponse)
    }
    return try JSONSerialization.jsonObject(with: data)
  }
}

public protocol LanguageAiding: Sendable {
  func translateLines(_ lines: [String], to: String) async -> [String]?
  func romanizeLines(_ lines: [String]) async -> [String]?
}

public extension LanguageAiding {
  func translateLines(_ lines: [String]) async -> [String]? {
    await translateLines(lines, to: "en")
  }
}
