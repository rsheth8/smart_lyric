// Finding timed lyrics for a song — the catalog chain from
// app/providers/lyrics/index.js, minus what a TV can't use (local files, AI
// transcription) and Musixmatch (captcha-blocked from Vercel, so it rarely hits):
//
//   NetEase word-level yrc (via our /api/lyrics proxy) → LRCLIB line-level
//   → LRCLIB search → LRCLIB title-only search → LRCLIB plain text, estimated.

import Foundation

public struct LyricsResult: Sendable {
  public var timeline: Timeline
  public var source: String
}

public enum LyricsService {
  public static func fetch(_ song: Song) async -> LyricsResult? {
    let track = cleanTrackTitle(song.track).nonEmpty ?? song.track
    let artist = primaryArtist(song.artist).nonEmpty ?? song.artist

    async let netease = fromNetease(artist: artist, track: track, duration: song.duration)
    async let exact = lrclibGet(artist: artist, track: track, duration: song.duration)
    let (yrc, lrclib) = await (netease, exact)

    var synced: [Candidate] = []
    if let yrc { synced.append(yrc) }
    if let lrclib, let tl = lrclib.synced { synced.append(Candidate(LyricsResult(timeline: tl, source: "lrclib"), lrclib.duration)) }
    if let best = prefer(synced, target: song.duration) { return best }

    let titles = [track, song.track]
    if let hit = await lrclibSearch(artist: artist, titles: titles, duration: song.duration) { return hit }
    if !artist.isEmpty, let hit = await lrclibSearch(artist: "", titles: titles, duration: song.duration) { return hit }

    if let plain = lrclib?.plain {
      return LyricsResult(timeline: estimateTimeline(plain, duration: song.duration ?? lrclib?.duration), source: "lrclib-plain")
    }
    return nil
  }

  struct Candidate {
    var result: LyricsResult
    var duration: Double?
    init(_ result: LyricsResult, _ duration: Double?) {
      self.result = result
      self.duration = duration
    }
  }

  private static func fromNetease(artist: String, track: String, duration: Double?) async -> Candidate? {
    var url = URLComponents(url: Companion.base.appendingPathComponent("api/lyrics"), resolvingAgainstBaseURL: false)!
    url.queryItems = [.init(name: "artist", value: artist), .init(name: "track", value: track)]
    if let duration { url.queryItems!.append(.init(name: "duration", value: String(Int(duration)))) }
    guard let json = await getJSON(url.url!.absoluteString) as? [String: Any],
          let yrc = json["yrc"] as? String
    else { return nil }
    let tl = parseYRC(yrc)
    guard !tl.lines.isEmpty else { return nil }
    let meta = json["meta"] as? [String: Any]
    return Candidate(LyricsResult(timeline: tl, source: "netease"), Companion.number(meta?["duration"]))
  }

  private static func lrclibGet(artist: String, track: String, duration: Double?) async
    -> (synced: Timeline?, plain: String?, duration: Double?)?
  {
    var url = URLComponents(string: "https://lrclib.net/api/get")!
    url.queryItems = [.init(name: "track_name", value: track)]
    if !artist.isEmpty { url.queryItems!.append(.init(name: "artist_name", value: artist)) }
    if let duration { url.queryItems!.append(.init(name: "duration", value: String(Int(duration.rounded())))) }
    guard let hit = await getJSON(url.url!.absoluteString) as? [String: Any] else { return nil }
    let synced = (hit["syncedLyrics"] as? String).map { parseLRC($0) }
    let plain = (hit["plainLyrics"] as? String)?.nonEmpty
    return (synced?.lines.isEmpty == false ? synced : nil, plain, Companion.number(hit["duration"]))
  }

  private static func lrclibSearch(artist: String, titles: [String], duration: Double?) async -> LyricsResult? {
    for title in Array(NSOrderedSet(array: titles)) as! [String] where !title.isEmpty {
      var url = URLComponents(string: "https://lrclib.net/api/search")!
      url.queryItems = [.init(name: "track_name", value: title)]
      if !artist.isEmpty { url.queryItems!.append(.init(name: "artist_name", value: artist)) }
      let list = await getJSON(url.url!.absoluteString) as? [[String: Any]] ?? []
      if let hit = pickBestMatch(list, artist: artist, track: title, duration: duration),
         let lrc = hit["syncedLyrics"] as? String
      {
        let tl = parseLRC(lrc)
        if !tl.lines.isEmpty { return LyricsResult(timeline: tl, source: "lrclib") }
      }
    }
    return nil
  }

  /// Richest timing first, but skip a hit whose length says it's the wrong recording.
  static func prefer(_ candidates: [Candidate], target: Double?) -> LyricsResult? {
    guard let first = candidates.first else { return nil }
    guard let target, target > 0 else { return first.result }
    let plausible = candidates.first { c in
      guard let d = c.duration, d > 0 else { return true }
      return abs(d - target) < 22
    }
    return (plausible ?? first).result
  }

  /// LRCLIB search hits ranked by artist, title similarity and length (lrclib.js pickBestMatch).
  static func pickBestMatch(_ list: [[String: Any]], artist: String, track: String, duration: Double?, minScore: Double = 0.5) -> [String: Any]? {
    var hits = list.filter { ($0["syncedLyrics"] as? String)?.isEmpty == false }
    let primary = primaryArtist(artist).lowercased()
    if !primary.isEmpty {
      let byArtist = hits.filter {
        let name = ($0["artistName"] as? String ?? "").lowercased()
        let first = name.split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return name.contains(primary) || (!first.isEmpty && primary.contains(first))
      }
      if !byArtist.isEmpty { hits = byArtist }
    }
    let want = cleanTrackTitle(track).nonEmpty ?? track
    func rank(_ hit: [String: Any]) -> Double {
      candidateScore(title: titleScore(want, hit["trackName"] as? String ?? ""), target: duration, candidate: Companion.number(hit["duration"]))
    }
    guard let best = hits.max(by: { rank($0) < rank($1) }) else { return nil }
    return titleScore(want, best["trackName"] as? String ?? "") >= minScore ? best : nil
  }
}

// MARK: - Title matching (app/providers/lyrics/lrclib.js, match.js)

private let slang: [(NSRegularExpression, String)] = [
  ("\\bem\\b", "them"), ("\\bcuz\\b", "because"), ("\\btil\\b", "till"), ("\\bout\\b", "about"),
].map { (NSRegularExpression($0.0, options: .caseInsensitive), $0.1) }
private let spaces = NSRegularExpression("\\s+")
private let bracketNoise = NSRegularExpression(
  "\\s*[(\\[][^)\\]]*(remaster|remix|live|bonus|deluxe|edit|version|mono|stereo|feat\\.?|ft\\.?|featuring|explicit|clean)[^)\\]]*[)\\]]",
  options: .caseInsensitive
)
private let dashNoise = NSRegularExpression("\\s*-\\s*(remastered.*|remix.*|live.*|bonus.*|mono|stereo)\\s*$", options: .caseInsensitive)
private let featTail = NSRegularExpression("\\s+(feat\\.?|ft\\.?|featuring)\\s+.+$", options: .caseInsensitive)
private let punctuation = NSRegularExpression("[^\\w\\s]")

public func normalizeTitle(_ s: String) -> String {
  slang.reduce(spaces.replace(in: s.trimmingCharacters(in: .whitespaces), with: " ")) { $1.0.replace(in: $0, with: $1.1) }
}

/// Strip "(feat. X)", "- Remastered 2011" and friends so catalogs still match.
public func cleanTrackTitle(_ s: String) -> String {
  var t = normalizeTitle(s)
  for re in [bracketNoise, dashNoise, featTail] { t = re.replace(in: t, with: "") }
  return spaces.replace(in: t, with: " ").trimmingCharacters(in: .whitespaces)
}

/// First credited artist only — "A, B" / "A feat. B" breaks artist filters.
public func primaryArtist(_ s: String) -> String {
  let first = s.split(separator: ",", omittingEmptySubsequences: false).first.map(String.init) ?? ""
  return featTail.replace(in: first, with: "").trimmingCharacters(in: .whitespaces)
}

func titleScore(_ query: String, _ candidate: String) -> Double {
  func canonical(_ s: String) -> String {
    spaces.replace(in: punctuation.replace(in: normalizeTitle(s).lowercased(), with: ""), with: " ")
      .trimmingCharacters(in: .whitespaces)
  }
  let q = canonical(query), c = canonical(candidate)
  if q.isEmpty || c.isEmpty { return 0 }
  if q == c { return 1 }
  if c.contains(q) || q.contains(c) { return 0.85 }
  let qw = Set(q.split(separator: " "))
  let cw = c.split(separator: " ")
  return Double(cw.filter { qw.contains($0) }.count) / Double(max(qw.count, cw.count))
}

/// Title similarity nudged ±0.3 by how well the lengths agree; unknown length leaves it alone.
func candidateScore(title: Double, target: Double?, candidate: Double?) -> Double {
  guard let a = target, let b = candidate, a > 0, b > 0 else { return title }
  let off = abs(a - b)
  let d = off <= 2.5 ? 1 : off >= 12 ? 0 : 1 - (off - 2.5) / 9.5
  return title + 0.6 * (d - 0.5)
}

extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
