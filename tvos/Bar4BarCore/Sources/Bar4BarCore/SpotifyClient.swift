import Foundation

/// Spotify "follow what's playing" for tvOS.
///
/// The Apple TV never plays Spotify audio — it *follows* it. Spotify's Web API
/// reports what is playing on any of the account's devices, so a phone, a
/// HomePod, or a desktop app all drive the lyrics on the television. That is the
/// same model as the Electron app's follow-poll, and the reason this feature is
/// worth having on a device that cannot host the Spotify SDK at all.
///
/// Authorization is not done here: tvOS has no browser and Spotify has no
/// device-code flow, so the handshake runs through this repo's `/api/tv-pair`
/// endpoints (see `lib/tv-pair.mjs`) and lands here as a refresh token.
public struct SpotifyClient: Sendable {
  public var apiBaseURL: URL
  public var session: URLSession
  public var timeout: TimeInterval

  public init(apiBaseURL: URL, session: URLSession = .shared, timeout: TimeInterval = 10) {
    self.apiBaseURL = apiBaseURL
    self.session = session
    self.timeout = timeout
  }

  // MARK: - Pairing (through our own server)

  public struct Pairing: Equatable, Sendable, Decodable {
    public let code: String
    public let pollToken: String
    public let expiresIn: Double
    public let verifyURL: String
    /// Encoded as a QR code on the TV. Scanning it goes straight to Spotify's
    /// consent screen with the code already applied. Optional so an older
    /// deployment that predates it still pairs, just without the shortcut.
    public let scanURL: String?
    /// False when the deployment has no KV bound, which on serverless means the
    /// handshake will usually fail. Worth saying out loud rather than letting
    /// the viewer stare at a code that can never be redeemed.
    public let durable: Bool
  }

  public struct Tokens: Equatable, Sendable, Decodable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresIn: Double

    enum CodingKeys: String, CodingKey {
      case accessToken = "access_token"
      case refreshToken = "refresh_token"
      case expiresIn = "expires_in"
    }
  }

  public enum PollResult: Equatable, Sendable {
    case pending
    case ready(Tokens)
    case expired
  }

  public func startPairing() async throws -> Pairing {
    let url = apiBaseURL.appendingPathComponent("api/tv-pair")
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    comps?.queryItems = [URLQueryItem(name: "action", value: "start")]
    guard let url = comps?.url else { throw URLError(.badURL) }
    let data = try await get(url)
    return try JSONDecoder().decode(Pairing.self, from: data)
  }

  public func pollPairing(token: String) async -> PollResult {
    var comps = URLComponents(
      url: apiBaseURL.appendingPathComponent("api/tv-pair"), resolvingAgainstBaseURL: false
    )
    comps?.queryItems = [
      URLQueryItem(name: "action", value: "poll"),
      URLQueryItem(name: "token", value: token),
    ]
    guard let url = comps?.url, let data = try? await get(url) else { return .pending }
    return Self.parsePoll(data)
  }

  public static func parsePoll(_ data: Data) -> PollResult {
    struct Envelope: Decodable {
      let status: String
      let tokens: Tokens?
    }
    guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else { return .pending }
    switch env.status {
    case "ready": return env.tokens.map { .ready($0) } ?? .expired
    case "expired": return .expired
    default: return .pending
    }
  }

  /// Refreshed server-side so the client id stays off the device.
  public func refresh(refreshToken: String) async throws -> Tokens {
    var comps = URLComponents(
      url: apiBaseURL.appendingPathComponent("api/tv-pair"), resolvingAgainstBaseURL: false
    )
    comps?.queryItems = [
      URLQueryItem(name: "action", value: "refresh"),
      URLQueryItem(name: "refresh_token", value: refreshToken),
    ]
    guard let url = comps?.url else { throw URLError(.badURL) }
    return try JSONDecoder().decode(Tokens.self, from: try await get(url))
  }

  // MARK: - Playback state

  public struct PlaybackState: Equatable, Sendable {
    public let trackID: String?
    public let item: CatalogItem
    public let progress: Double
    public let isPlaying: Bool

    /// Advance a stale `progress_ms` by half the request RTT, matching
    /// `app/streaming/spotify.js`. Capped so a hung poll cannot jump the wipe.
    public func compensating(rtt: TimeInterval) -> PlaybackState {
      PlaybackState(
        trackID: trackID,
        item: item,
        progress: SpotifyClient.compensatedProgress(progress: progress, isPlaying: isPlaying, rtt: rtt),
        isPlaying: isPlaying
      )
    }
  }

  /// `progress_ms` was sampled one one-way trip before it arrived. Add that
  /// estimate while playing so the clock aims at now, not at the request start.
  public static func compensatedProgress(progress: Double, isPlaying: Bool, rtt: TimeInterval) -> Double {
    guard isPlaying, rtt.isFinite, rtt > 0 else { return progress }
    return progress + min(rtt / 2, 0.35)
  }

  /// Poll faster in the last seconds so the next-song handoff is not a second late.
  public static func followPollInterval(remaining: Double?, isPlaying: Bool) -> TimeInterval {
    guard isPlaying, let remaining, remaining.isFinite, remaining > 0 else { return 1 }
    if remaining < 8 { return 0.4 }
    if remaining < 25 { return 0.8 }
    return 1
  }

  /// Commands that move the account's active Spotify device. The TV never
  /// hosts audio; these hit whatever phone, speaker, or computer is already
  /// playing. Needs `user-modify-playback-state` and Spotify Premium.
  public enum PlayerCommand: Equatable, Sendable {
    case pause, play, next, previous
    case seekMs(Int)

    public var urlRequest: URLRequest {
      switch self {
      case .pause:
        return Self.put("https://api.spotify.com/v1/me/player/pause")
      case .play:
        return Self.put("https://api.spotify.com/v1/me/player/play")
      case .next:
        return Self.post("https://api.spotify.com/v1/me/player/next")
      case .previous:
        return Self.post("https://api.spotify.com/v1/me/player/previous")
      case .seekMs(let ms):
        var comps = URLComponents(string: "https://api.spotify.com/v1/me/player/seek")
        comps?.queryItems = [URLQueryItem(name: "position_ms", value: String(max(0, ms)))]
        var req = URLRequest(url: comps?.url ?? URL(string: "https://api.spotify.com/v1/me/player/seek")!)
        req.httpMethod = "PUT"
        return req
      }
    }

    private static func put(_ raw: String) -> URLRequest {
      var req = URLRequest(url: URL(string: raw)!)
      req.httpMethod = "PUT"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      return req
    }

    private static func post(_ raw: String) -> URLRequest {
      var req = URLRequest(url: URL(string: raw)!)
      req.httpMethod = "POST"
      return req
    }
  }

  public func sendPlayerCommand(_ command: PlayerCommand, accessToken: String) async throws {
    var req = command.urlRequest
    req.timeoutInterval = timeout
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    req.setValue("Bar4BarTV/0.1", forHTTPHeaderField: "User-Agent")
    let (_, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if http.statusCode == 204 || (200..<300).contains(http.statusCode) { return }
    if http.statusCode == 401 { throw SpotifyError.unauthorized }
    if http.statusCode == 403 { throw SpotifyError.forbidden }
    if http.statusCode == 404 { throw SpotifyError.noActiveDevice }
    if http.statusCode == 429 {
      throw SpotifyError.rateLimited(max(1, Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 30))
    }
    throw SpotifyError.http(http.statusCode)
  }

  /// `/me/player/currently-playing`. Nil means nothing is playing — a 204 with
  /// no body, which is a normal state and not an error.
  public func currentlyPlaying(accessToken: String) async throws -> PlaybackState? {
    let url = URL(string: "https://api.spotify.com/v1/me/player/currently-playing")!
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let started = ProcessInfo.processInfo.systemUptime
    let (data, response) = try await session.data(for: req)
    let rtt = ProcessInfo.processInfo.systemUptime - started
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if http.statusCode == 204 { return nil }
    if http.statusCode == 401 { throw SpotifyError.unauthorized }
    if http.statusCode == 429 {
      throw SpotifyError.rateLimited(max(1, Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 30))
    }
    guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    return Self.parsePlayback(data)?.compensating(rtt: rtt)
  }

  /// Head of the play queue — the track that will start after this one.
  /// 403 means this token predates the queue scope; treat as empty, do not
  /// drop the follow session. Requires `user-read-playback-state`.
  public func nextInQueue(accessToken: String) async throws -> CatalogItem? {
    let url = URL(string: "https://api.spotify.com/v1/me/player/queue")!
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if http.statusCode == 204 || http.statusCode == 403 || http.statusCode == 404 { return nil }
    if http.statusCode == 401 { throw SpotifyError.unauthorized }
    if http.statusCode == 429 {
      throw SpotifyError.rateLimited(max(1, Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 30))
    }
    guard (200..<300).contains(http.statusCode) else { return nil }
    return NextPrep.parseQueueHead(data)
  }

  public static func parsePlayback(_ data: Data) -> PlaybackState? {
    struct Payload: Decodable {
      let progress_ms: Double?
      let is_playing: Bool?
      let currently_playing_type: String?
      let item: SpotifyTrackItem?
    }
    guard let payload = try? JSONDecoder().decode(Payload.self, from: data),
          // This endpoint also returns podcast episodes and audiobooks. They
          // share enough optional fields with a track to decode successfully,
          // but sending one into the song lyric pipeline produces a convincing
          // yet useless "no lyrics" failure. Missing keeps fixture/backward
          // compatibility; Spotify's live response supplies `track` here.
          payload.currently_playing_type == nil || payload.currently_playing_type == "track",
          let item = payload.item?.catalogItem()
    else { return nil }

    return PlaybackState(
      trackID: payload.item?.id,
      item: item,
      progress: (payload.progress_ms ?? 0) / 1000,
      isPlaying: payload.is_playing ?? false
    )
  }

  private func get(_ url: URL) async throws -> Data {
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue("Bar4BarTV/0.1", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { return data }
    guard !(200..<300).contains(http.statusCode) else { return data }

    // Every non-2xx used to collapse into `URLError(.badServerResponse)`, which
    // reaches the screen as "NSURLErrorDomain error -1011" — a string that tells
    // the viewer nothing and the developer almost nothing. The endpoints answer
    // with `{ "error": "…" }` written to be read; surface it.
    throw SpotifyError.from(status: http.statusCode, body: data)
  }
}

public enum SpotifyError: Error, Equatable {
  case unauthorized
  case rateLimited(Double)
  /// Token is missing `user-modify-playback-state`, or the account is Free.
  case forbidden
  /// Spotify has no active device to command.
  case noActiveDevice
  /// The deployment has no `/api/tv-pair`. By far the most likely failure on a
  /// first run, and the one with the least guessable cause.
  case notDeployed
  /// The server explained itself. Message is safe to show.
  case server(String)
  case http(Int)

  static func from(status: Int, body: Data) -> SpotifyError {
    if status == 401 { return .unauthorized }
    struct Envelope: Decodable { let error: String? }
    if let message = (try? JSONDecoder().decode(Envelope.self, from: body))?.error,
       !message.isEmpty {
      return .server(message)
    }
    // A 404 with a non-JSON body is Vercel's own "page could not be found",
    // i.e. this build of the site predates the pairing endpoints.
    if status == 404 { return .notDeployed }
    return .http(status)
  }
}

extension SpotifyError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .rateLimited:
      return "Spotify is busy. Please try again shortly."
    case .unauthorized:
      return "Spotify rejected the sign-in. Connect again."
    case .forbidden:
      return "Reconnect Spotify to pause and skip from this TV. Spotify Premium is required."
    case .noActiveDevice:
      return "Start a song in Spotify, then try again."
    case .notDeployed:
      return "Spotify connection is temporarily unavailable. The connection service needs an update. You can still use Apple Music or explore the demo."
    case .server(let message):
      return message
    case .http(let status):
      return "The pairing server returned an error (\(status))."
    }
  }
}
