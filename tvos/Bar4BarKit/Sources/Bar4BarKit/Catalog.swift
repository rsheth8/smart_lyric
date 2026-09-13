// Songs to pick from: the iTunes chart and iTunes Search (app/recommendations.js).

import Foundation

public struct Song: Codable, Hashable, Identifiable, Sendable {
  public var track: String
  public var artist: String
  public var artwork: String?
  /// Seconds, when the catalog knows it — the best way to pick the right recording's lyrics.
  public var duration: Double?
  /// Guest who picked it from their phone.
  public var by: String?

  public init(track: String, artist: String, artwork: String? = nil, duration: Double? = nil, by: String? = nil) {
    self.track = track
    self.artist = artist
    self.artwork = artwork
    self.duration = duration
    self.by = by
  }

  public var id: String { "\(artist.lowercased())|\(track.lowercased())" }
}

public enum Catalog {
  private static let artSize = NSRegularExpression("/\\d+x\\d+bb\\.(?:png|jpg|jpeg)$", options: .caseInsensitive)

  /// The chart feed offers 170px art and Search 100px; ask the CDN for a poster-sized rendition.
  public static func upgradeArtwork(_ url: String?, size: Int = 600) -> String? {
    guard let url, !url.isEmpty else { return nil }
    return artSize.replace(in: url, with: "/\(size)x\(size)bb.jpg")
  }

  public static func topSongs(limit: Int = 25) async -> [Song] {
    guard let json = await getJSON("https://itunes.apple.com/us/rss/topsongs/limit=\(limit)/json") as? [String: Any],
          let entries = (json["feed"] as? [String: Any])?["entry"] as? [[String: Any]]
    else { return [] }
    func label(_ v: Any?) -> String? { (v as? [String: Any])?["label"] as? String }
    return unique(entries.compactMap { e in
      guard let track = label(e["im:name"]), !track.isEmpty else { return nil }
      let images = e["im:image"] as? [Any] ?? []
      return Song(track: track, artist: label(e["im:artist"]) ?? "", artwork: upgradeArtwork(label(images.last)))
    })
  }

  public static func search(_ query: String, limit: Int = 25) async -> [Song] {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard q.count >= 2 else { return [] }
    var url = URLComponents(string: "https://itunes.apple.com/search")!
    url.queryItems = [
      .init(name: "term", value: q), .init(name: "media", value: "music"),
      .init(name: "entity", value: "song"), .init(name: "limit", value: String(limit)),
    ]
    guard let json = await getJSON(url.url!.absoluteString) as? [String: Any],
          let results = json["results"] as? [[String: Any]]
    else { return [] }
    return unique(results.compactMap { r in
      guard let track = r["trackName"] as? String, !track.isEmpty else { return nil }
      return Song(
        track: track,
        artist: r["artistName"] as? String ?? "",
        artwork: upgradeArtwork(r["artworkUrl100"] as? String),
        duration: Companion.number(r["trackTimeMillis"]).map { ($0 / 1000).rounded() }
      )
    })
  }

  /// The same song turns up once per album; one card each.
  static func unique(_ songs: [Song]) -> [Song] {
    var seen = Set<String>()
    return songs.filter { seen.insert($0.id).inserted }
  }
}

func getJSON(_ url: String, timeout: TimeInterval = 10) async -> Any? {
  guard let u = URL(string: url) else { return nil }
  var req = URLRequest(url: u, timeoutInterval: timeout)
  req.setValue("Bar4Bar tvOS (https://smartlyric.vercel.app)", forHTTPHeaderField: "User-Agent")
  guard let (data, res) = try? await URLSession.shared.data(for: req),
        (res as? HTTPURLResponse)?.statusCode == 200
  else { return nil }
  return try? JSONSerialization.jsonObject(with: data)
}
