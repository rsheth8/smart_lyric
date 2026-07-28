import Foundation

/// Fetches + orchestrates catalog lyrics for tvOS.
///
/// Calls the existing Vercel proxies (`/api/lyrics`, `/api/richsync`) when
/// `apiBaseURL` is set, plus public LRCLIB. Never embeds provider secrets.
public struct LyricsClient: Sendable {
  public var apiBaseURL: URL?
  public var session: URLSession
  public var timeout: TimeInterval

  public init(
    apiBaseURL: URL? = nil,
    session: URLSession = .shared,
    timeout: TimeInterval = 12
  ) {
    self.apiBaseURL = apiBaseURL
    self.session = session
    self.timeout = timeout
  }

  public struct Query: Equatable, Sendable {
    public var artist: String
    public var track: String
    public var duration: Double?

    public init(artist: String, track: String, duration: Double? = nil) {
      self.artist = artist
      self.track = track
      self.duration = duration
    }
  }

  /// Parallel catalog fetch: NetEase (via proxy) → LRCLIB → richsync (via proxy).
  public func fetch(_ query: Query) async -> LyricsResult? {
    async let netease = fetchNetease(query)
    async let lrclib = fetchLRCLIB(query)
    async let richsync = fetchRichsync(query)

    let results = await [netease, richsync, lrclib]
    return Match.preferResult(results, targetDuration: query.duration)
  }

  // MARK: - NetEase proxy

  private struct NeteasePayload: Decodable {
    var yrc: String?
    var lrc: String?
    var meta: Meta?
    struct Meta: Decodable {
      var duration: Double?
      var artist: String?
      var track: String?
    }
  }

  private func fetchNetease(_ query: Query) async -> LyricsResult? {
    guard let base = apiBaseURL else { return nil }
    var comps = URLComponents(url: base.appendingPathComponent("api/lyrics"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [
      URLQueryItem(name: "artist", value: query.artist),
      URLQueryItem(name: "track", value: query.track),
      query.duration.map { URLQueryItem(name: "duration", value: String(Int($0.rounded()))) },
    ].compactMap { $0 }
    guard let url = comps?.url else { return nil }
    guard let data = try? await get(url),
          let payload = try? JSONDecoder().decode(NeteasePayload.self, from: data)
    else { return nil }

    let meta = LyricsMeta(
      duration: payload.meta?.duration.map { $0 > 1000 ? $0 / 1000 : $0 },
      artist: payload.meta?.artist ?? query.artist,
      track: payload.meta?.track ?? query.track
    )
    if let yrc = payload.yrc, !yrc.isEmpty {
      let tl = YRC.parse(yrc)
      if !tl.isEmpty {
        return LyricsResult(timeline: Timeline(lines: tl.lines, duration: tl.duration, source: "yrc"), meta: meta, richness: 0)
      }
    }
    if let lrc = payload.lrc, !lrc.isEmpty {
      let tl = LRC.parse(lrc)
      if !tl.isEmpty {
        return LyricsResult(timeline: Timeline(lines: tl.lines, duration: tl.duration, source: "lrc"), meta: meta, richness: 1)
      }
    }
    return nil
  }

  // MARK: - Richsync proxy

  private struct RichsyncPayload: Decodable {
    var richsync: String?
    var meta: NeteasePayload.Meta?
  }

  private func fetchRichsync(_ query: Query) async -> LyricsResult? {
    guard let base = apiBaseURL else { return nil }
    var comps = URLComponents(url: base.appendingPathComponent("api/richsync"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [
      URLQueryItem(name: "artist", value: query.artist),
      URLQueryItem(name: "track", value: query.track),
    ]
    guard let url = comps?.url else { return nil }
    guard let data = try? await get(url),
          let payload = try? JSONDecoder().decode(RichsyncPayload.self, from: data),
          let body = payload.richsync, !body.isEmpty
    else { return nil }
    let tl = Richsync.parse(body)
    guard !tl.isEmpty else { return nil }
    let meta = LyricsMeta(
      duration: payload.meta?.duration.map { $0 > 1000 ? $0 / 1000 : $0 },
      artist: payload.meta?.artist ?? query.artist,
      track: payload.meta?.track ?? query.track
    )
    return LyricsResult(timeline: Timeline(lines: tl.lines, duration: tl.duration, source: "richsync"), meta: meta, richness: 0)
  }

  // MARK: - LRCLIB (public)

  private struct LRCLIBHit: Decodable {
    var syncedLyrics: String?
    var plainLyrics: String?
    var duration: Double?
    var artistName: String?
    var trackName: String?
  }

  private func fetchLRCLIB(_ query: Query) async -> LyricsResult? {
    var comps = URLComponents(string: "https://lrclib.net/api/search")
    comps?.queryItems = [
      URLQueryItem(name: "artist_name", value: TitleMatch.primaryArtist(query.artist)),
      URLQueryItem(name: "track_name", value: TitleMatch.cleanTrackTitle(query.track)),
    ]
    guard let url = comps?.url,
          let data = try? await get(url),
          let hits = try? JSONDecoder().decode([LRCLIBHit].self, from: data)
    else { return nil }

    let ranked = hits
      .filter { ($0.syncedLyrics ?? "").isEmpty == false }
      .map { hit -> (LRCLIBHit, Double) in
        let score = Match.candidateScore(
          titleScore: TitleMatch.titleScore(query: query.track, candidate: hit.trackName ?? ""),
          targetDuration: query.duration,
          candidateDuration: hit.duration
        )
        return (hit, score)
      }
      .sorted { $0.1 > $1.1 }

    guard let best = ranked.first, best.1 >= 0.5,
          let synced = best.0.syncedLyrics, !synced.isEmpty
    else { return nil }

    let tl = LRC.parse(synced)
    guard !tl.isEmpty else { return nil }
    return LyricsResult(
      timeline: Timeline(lines: tl.lines, duration: tl.duration, source: "lrclib"),
      meta: LyricsMeta(
        duration: best.0.duration,
        artist: best.0.artistName ?? query.artist,
        track: best.0.trackName ?? query.track
      ),
      richness: 1
    )
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
}
