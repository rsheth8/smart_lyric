import Foundation

/// Browse data that needs no key, no subscription, and no MusicKit.
///
/// The Apple TV app used to source every browse surface from MusicKit, which
/// quietly made the whole hub unrenderable anywhere MusicKit refuses to run —
/// i.e. the simulator, the only place we can actually look at it. It also meant
/// someone without an Apple Music subscription saw an empty app.
///
/// Both feeds here are the same public ones the web hub uses
/// (`app/recommendations.js`): the iTunes charts RSS and the iTunes Search API.
/// No key, no auth, CORS-open, and available on a plain `URLSession`.
///
/// The payoff beyond "it renders": the chart feed's `im:id` and Search's
/// `trackId` are both the **Apple Music catalog id**, so an item picked here
/// resolves to a playable `Song` by exact id rather than by fuzzy title match.
/// Browse is public; only playback needs MusicKit.
public struct CatalogClient: Sendable {
  public var storefront: String
  public var session: URLSession
  public var timeout: TimeInterval

  public init(
    storefront: String = "us",
    session: URLSession = .shared,
    timeout: TimeInterval = 10
  ) {
    self.storefront = storefront
    self.session = session
    self.timeout = timeout
  }

  // MARK: - Charts

  /// The "Recommended / Top songs right now" shelf.
  ///
  /// Returns `[]` rather than throwing: a hub whose chart shelf failed should
  /// simply not show that shelf, never an error banner over the whole screen.
  public func charts(limit: Int = 12) async -> [CatalogItem] {
    let url = URL(
      string: "https://itunes.apple.com/\(storefront)/rss/topsongs/limit=\(limit)/json"
    )
    guard let url, let data = try? await get(url) else { return [] }
    return Self.parseCharts(data)
  }

  // MARK: - Search

  /// Song search. Empty array for a blank or one-character term — the iTunes
  /// endpoint will happily answer those with noise.
  public func search(_ term: String, limit: Int = 24) async -> [CatalogItem] {
    (try? await searchResults(term, limit: limit)) ?? []
  }

  public func searchResults(_ term: String, limit: Int = 24) async throws -> [CatalogItem] {
    let q = term.trimmingCharacters(in: .whitespacesAndNewlines)
    guard q.count >= 2 else { return [] }
    var comps = URLComponents(string: "https://itunes.apple.com/search")
    comps?.queryItems = [
      URLQueryItem(name: "term", value: q),
      URLQueryItem(name: "country", value: storefront),
      URLQueryItem(name: "media", value: "music"),
      URLQueryItem(name: "entity", value: "song"),
      URLQueryItem(name: "limit", value: String(limit)),
    ]
    guard let url = comps?.url else { throw URLError(.badURL) }
    let data = try await get(url)
    _ = try JSONDecoder().decode(SearchPayload.self, from: data)
    return Self.parseSearch(data)
  }

  // MARK: - Parsing (pure, so it can be tested without a network)

  public static func parseCharts(_ data: Data) -> [CatalogItem] {
    guard let feed = try? JSONDecoder().decode(ChartFeed.self, from: data) else { return [] }
    return feed.feed.entry.compactMap { entry in
      let title = entry.name.label
      guard !title.isEmpty else { return nil }
      // `im:image` is ordered smallest first (55 / 60 / 170). Take the largest
      // and upgrade it — every one of them is the same asset at a different
      // rendition, so which one we start from only affects the fallback.
      return CatalogItem(
        id: entry.id.attributes.trackID,
        title: title,
        artist: entry.artist.label,
        album: entry.collection?.name.label,
        artworkURL: Artwork.upgrade(entry.images.last?.label),
        duration: nil
      )
    }
  }

  public static func parseSearch(_ data: Data) -> [CatalogItem] {
    guard let payload = try? JSONDecoder().decode(SearchPayload.self, from: data) else { return [] }
    return payload.results.compactMap { hit in
      guard let title = hit.trackName, !title.isEmpty else { return nil }
      return CatalogItem(
        id: hit.trackId.map(String.init) ?? "",
        title: title,
        artist: hit.artistName ?? "",
        album: hit.collectionName,
        artworkURL: Artwork.upgrade(hit.artworkUrl100),
        duration: hit.trackTimeMillis.map { Double($0) / 1000 }
      )
    }
  }

  private func get(_ url: URL) async throws -> Data {
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue("Bar4BarTV/0.1", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await session.data(for: req)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw URLError(.badServerResponse)
    }
    return data
  }

  // MARK: - Wire formats

  struct ChartFeed: Decodable {
    let feed: Feed
    struct Feed: Decodable { let entry: [Entry] }

    struct Entry: Decodable {
      let name: Label
      let artist: Label
      let images: [Label]
      let id: EntryID
      let collection: Collection?

      enum CodingKeys: String, CodingKey {
        case name = "im:name"
        case artist = "im:artist"
        case images = "im:image"
        case collection = "im:collection"
        case id
      }
    }

    struct Label: Decodable { let label: String }

    struct Collection: Decodable {
      let name: Label
      enum CodingKeys: String, CodingKey { case name = "im:name" }
    }

    struct EntryID: Decodable {
      let attributes: Attributes
      struct Attributes: Decodable {
        let trackID: String
        enum CodingKeys: String, CodingKey { case trackID = "im:id" }
      }
    }
  }

  struct SearchPayload: Decodable {
    let results: [Hit]
    struct Hit: Decodable {
      let trackId: Int?
      let trackName: String?
      let artistName: String?
      let collectionName: String?
      let artworkUrl100: String?
      let trackTimeMillis: Int?
    }
  }
}

/// One browsable song, independent of where it came from.
public struct CatalogItem: Identifiable, Equatable, Hashable, Sendable, Codable {
  /// The Apple Music catalog id when we have one, so playback can resolve it
  /// exactly. Empty for sources that do not carry one (a Spotify now-playing
  /// track, say) — those fall back to a title/artist match.
  public let id: String
  public let title: String
  public let artist: String
  public let album: String?
  public let artworkURL: URL?
  public let duration: Double?
  public let recording: RecordingIdentity?

  public init(
    id: String,
    title: String,
    artist: String,
    album: String? = nil,
    artworkURL: URL? = nil,
    duration: Double? = nil,
    recording: RecordingIdentity? = nil
  ) {
    self.id = id
    self.title = title
    self.artist = artist
    self.album = album
    self.artworkURL = artworkURL
    self.duration = duration
    self.recording = recording
  }
}

public enum Artwork {
  /// Ask the iTunes CDN for a bigger rendition of an artwork URL.
  ///
  /// Every iTunes artwork URL ends in `/<w>x<h>bb.<ext>`, and the CDN serves any
  /// size and either extension you name. The catalog feeds hand back 100–170px
  /// thumbnails; a 170px source in a 260pt card on a 2× panel is a 3× upscale
  /// and visibly mushes.
  ///
  /// The extension is forced to `.jpg` because the chart RSS hands out `.png`
  /// URLs, and at 600px the same cover is ~287KB as PNG against ~105KB as JPEG.
  /// Album art is photographic; PNG buys nothing and the hub loads twelve.
  public static func upgrade(_ url: String?, size: Int = 600) -> URL? {
    guard let url, !url.isEmpty else { return nil }
    let pattern = #"/\d+x\d+bb\.(?:png|jpg|jpeg)$"#
    let upgraded = url.replacingOccurrences(
      of: pattern,
      with: "/\(size)x\(size)bb.jpg",
      options: [.regularExpression, .caseInsensitive]
    )
    return URL(string: upgraded)
  }
}
