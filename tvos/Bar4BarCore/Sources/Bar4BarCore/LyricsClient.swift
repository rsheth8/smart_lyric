import Foundation

/// Fetches + orchestrates catalog lyrics for tvOS.
///
/// Calls the existing Vercel proxies (`/api/lyrics`, `/api/richsync`) when
/// `apiBaseURL` is set, plus public LRCLIB. Never embeds provider secrets.
public struct LyricsClient: Sendable {
  public var apiBaseURL: URL?
  public var session: URLSession
  public var timeout: TimeInterval
  public var officialOnly: Bool

  public init(
    apiBaseURL: URL? = nil,
    session: URLSession = .shared,
    timeout: TimeInterval = 20,
    officialOnly: Bool = false
  ) {
    self.apiBaseURL = apiBaseURL
    self.session = session
    self.timeout = timeout
    self.officialOnly = officialOnly
  }

  public struct Query: Equatable, Sendable {
    public var artist: String
    public var track: String
    public var duration: Double?
    public var album: String?
    public var recording: RecordingIdentity?

    public init(artist: String, track: String, duration: Double? = nil,
                album: String? = nil, recording: RecordingIdentity? = nil) {
      self.artist = artist
      self.track = track
      self.duration = duration
      self.album = album
      self.recording = recording
    }
  }

  /// Parallel catalog fetch: NetEase (via proxy) → LRCLIB → richsync (via proxy).
  public func fetch(_ query: Query) async -> LyricsResult? {
    async let prepared = fetchPrepared(query)
    async let netease: LyricsResult? = officialOnly ? nil : fetchNetease(query)
    async let lrclib: LyricsResult? = officialOnly ? nil : fetchLRCLIB(query)
    async let richsync = fetchRichsync(query)

    let results = await [netease, richsync, prepared, lrclib]
    return Match.preferResult(results, targetDuration: query.duration)
  }

  private struct PreparedPayload: Decodable {
    var version: Int
    var meta: LyricsMeta
    var timeline: Timeline
  }

  private func fetchPrepared(_ query: Query) async -> LyricsResult? {
    guard let base = apiBaseURL, let duration = query.duration else { return nil }
    var comps = URLComponents(url: base.appendingPathComponent("api/word-timings"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [URLQueryItem(name: "artist", value: query.artist),
      URLQueryItem(name: "track", value: query.track), URLQueryItem(name: "duration", value: String(duration))]
      + (query.recording?.queryItems ?? [])
    guard let url = comps?.url, let data = try? await get(url),
          let payload = try? JSONDecoder().decode(PreparedPayload.self, from: data),
          payload.version == 1, payload.timeline.source == "aligned", !payload.timeline.isEmpty,
          matches(query, meta: payload.meta), let matchedDuration = payload.meta.duration,
          abs(matchedDuration - duration) <= 2.5 else { return nil }
    if let recording = query.recording, recording.hasIdentifier,
       !recording.matches(payload.meta.recording) { return nil }
    // Reject malformed imports before their values reach a per-frame renderer.
    var previous = -Double.infinity
    for line in payload.timeline.lines {
      guard line.start.isFinite, line.end.isFinite, line.start >= previous,
            line.start >= 0, line.end >= line.start, line.end <= duration + 3, !line.words.isEmpty else { return nil }
      previous = line.start
      var wordStart = line.start
      for word in line.words {
        guard word.start.isFinite, word.end.isFinite, word.start >= wordStart,
              word.end >= word.start, word.end <= line.end + 0.001, !word.text.isEmpty else { return nil }
        wordStart = word.start
      }
    }
    return LyricsResult(timeline: payload.timeline, meta: payload.meta,
      richness: payload.timeline.hasWordTiming && query.recording?.matches(payload.meta.recording) == true ? -1 : 1)
  }

  // MARK: - NetEase proxy

  private struct NeteasePayload: Decodable {
    var yrc: String?
    var lrc: String?
    /// NetEase `romalrc` — Latin-letter pronunciation, same timestamps as `lrc`.
    var rlrc: String?
    var meta: Meta?
    struct Meta: Decodable {
      var duration: Double?
      var artist: String?
      var track: String?
      var artistName: String?
      var trackName: String?
    }
  }

  private func fetchNetease(_ query: Query) async -> LyricsResult? {
    guard let base = apiBaseURL else { return nil }
    var comps = URLComponents(url: base.appendingPathComponent("api/lyrics"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [
      URLQueryItem(name: "artist", value: query.artist),
      URLQueryItem(name: "track", value: query.track),
      query.duration.map { URLQueryItem(name: "duration", value: String($0)) },
    ].compactMap { $0 }
    guard let url = comps?.url else { return nil }
    guard let data = try? await get(url),
          let payload = try? JSONDecoder().decode(NeteasePayload.self, from: data)
    else { return nil }

    let meta = LyricsMeta(
      duration: payload.meta?.duration.map { $0 > 1000 ? $0 / 1000 : $0 },
      artist: payload.meta?.artistName ?? payload.meta?.artist ?? query.artist,
      track: payload.meta?.trackName ?? payload.meta?.track ?? query.track
    )
    guard matches(query, meta: meta) else { return nil }
    if let yrc = payload.yrc, !yrc.isEmpty {
      let tl = YRC.parse(yrc)
      if !tl.isEmpty {
        return LyricsResult(
          timeline: withRoman(Timeline(lines: tl.lines, duration: tl.duration, source: "yrc"), rlrc: payload.rlrc),
          meta: meta,
          richness: 0
        )
      }
    }
    if let lrc = payload.lrc, !lrc.isEmpty {
      let tl = LRC.parse(lrc)
      if !tl.isEmpty {
        return LyricsResult(
          timeline: withRoman(tl, rlrc: payload.rlrc),
          meta: meta,
          richness: tl.hasWordTiming ? 0 : 2
        )
      }
    }
    return nil
  }

  private func withRoman(_ timeline: Timeline, rlrc: String?) -> Timeline {
    guard let rlrc, !rlrc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return timeline }
    var tl = timeline
    LineOverlay.attach(rlrc, as: .roman, to: &tl)
    return tl
  }

  // MARK: - Richsync proxy

  private struct RichsyncPayload: Decodable {
    var richsync: String?
    var meta: NeteasePayload.Meta?
    var cacheable: Bool?
    var licensed: Bool?
  }

  private func fetchRichsync(_ query: Query) async -> LyricsResult? {
    guard let base = apiBaseURL else { return nil }
    var comps = URLComponents(url: base.appendingPathComponent("api/richsync"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [
      URLQueryItem(name: "artist", value: query.artist),
      URLQueryItem(name: "track", value: query.track),
      query.duration.map { URLQueryItem(name: "duration", value: String($0)) },
    ].compactMap { $0 } + (query.recording?.queryItems ?? [])
    guard let url = comps?.url else { return nil }
    guard let data = try? await get(url),
          let payload = try? JSONDecoder().decode(RichsyncPayload.self, from: data),
          let body = payload.richsync, !body.isEmpty
    else { return nil }
    guard !officialOnly || payload.licensed == true else { return nil }
    let tl = Richsync.parse(body)
    guard !tl.isEmpty else { return nil }
    let meta = LyricsMeta(
      duration: payload.meta?.duration.map { $0 > 1000 ? $0 / 1000 : $0 },
      artist: payload.meta?.artistName ?? payload.meta?.artist ?? query.artist,
      track: payload.meta?.trackName ?? payload.meta?.track ?? query.track
    )
    guard matches(query, meta: meta) else { return nil }
    return LyricsResult(
      timeline: tl,
      meta: meta,
      richness: tl.hasWordTiming ? 0 : 2,
      cacheable: payload.cacheable ?? !(payload.licensed ?? false)
    )
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
      .filter { ($0.syncedLyrics ?? "").isEmpty == false
        && matches(query, meta: LyricsMeta(duration: $0.duration, artist: $0.artistName, track: $0.trackName)) }
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
      timeline: Timeline(lines: tl.lines, duration: tl.duration, estimated: tl.estimated, source: tl.hasWordTiming ? "elrc" : "lrclib"),
      meta: LyricsMeta(
        duration: best.0.duration,
        artist: best.0.artistName ?? query.artist,
        track: best.0.trackName ?? query.track
      ),
      richness: tl.hasWordTiming ? 0 : 2
    )
  }

  /// A rich timeline for a different song is worse than no result.
  private func matches(_ query: Query, meta: LyricsMeta) -> Bool {
    guard let title = meta.track, let artist = meta.artist else { return false }
    return TitleMatch.titleScore(query: TitleMatch.cleanTrackTitle(query.track),
                                 candidate: TitleMatch.cleanTrackTitle(title)) >= 0.75
      && TitleMatch.titleScore(query: TitleMatch.primaryArtist(query.artist),
                              candidate: TitleMatch.primaryArtist(artist)) >= 0.75
      && !Match.durationMismatch(targetSec: query.duration, candidateSec: meta.duration)
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
