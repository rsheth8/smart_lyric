import Foundation

/// Title / artist normalization for catalog matching (port of lrclib.js helpers).
public enum TitleMatch {
  public static func normalizeTitle(_ s: String) -> String {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    let pairs: [(String, String)] = [
      (#"\bem\b"#, "them"),
      (#"\bcuz\b"#, "because"),
      (#"\btil\b"#, "till"),
      (#"\bout\b"#, "about"),
    ]
    for (pat, rep) in pairs {
      t = t.replacingOccurrences(of: pat, with: rep, options: [.regularExpression, .caseInsensitive])
    }
    return t
  }

  public static func cleanTrackTitle(_ s: String) -> String {
    var t = normalizeTitle(s)
    t = t.replacingOccurrences(
      of: #"\s*[(\[][^)\]]*(remaster|remix|live|bonus|deluxe|edit|version|mono|stereo|feat\.?|ft\.?|featuring|explicit|clean)[^)\]]*[)\]]"#,
      with: "",
      options: [.regularExpression, .caseInsensitive]
    )
    t = t.replacingOccurrences(
      of: #"\s*-\s*(remastered.*|remix.*|live.*|bonus.*|mono|stereo)\s*$"#,
      with: "",
      options: [.regularExpression, .caseInsensitive]
    )
    t = t.replacingOccurrences(
      of: #"\s+(feat\.?|ft\.?|featuring)\s+.+$"#,
      with: "",
      options: [.regularExpression, .caseInsensitive]
    )
    t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    return t.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func primaryArtist(_ s: String) -> String {
    guard !s.isEmpty else { return "" }
    var first = s.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: true)
      .first.map(String.init) ?? s
    first = first.replacingOccurrences(
      of: #"\s+(feat\.?|ft\.?|featuring)\s+.+$"#,
      with: "",
      options: [.regularExpression, .caseInsensitive]
    )
    return first.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func canonicalTitle(_ s: String) -> String {
    let n = normalizeTitle(s).lowercased()
    let stripped = n.unicodeScalars
      .filter { CharacterSet.alphanumerics.contains($0) || $0 == " " }
      .map(String.init)
      .joined()
    return stripped.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func titleScore(query: String, candidate: String) -> Double {
    let q = canonicalTitle(query)
    let c = canonicalTitle(candidate)
    if q.isEmpty || c.isEmpty { return 0 }
    if c == q { return 1 }
    if c.contains(q) || q.contains(c) { return 0.85 }
    let qw = Set(q.split(separator: " ").map(String.init))
    let cw = c.split(separator: " ").map(String.init)
    let overlap = cw.filter { qw.contains($0) }.count
    return Double(overlap) / Double(max(qw.count, cw.count))
  }
}
