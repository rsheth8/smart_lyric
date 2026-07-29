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
    public let item: CatalogItem
    public let progress: Double
    public let isPlaying: Bool
  }

  /// `/me/player/currently-playing`. Nil means nothing is playing — a 204 with
  /// no body, which is a normal state and not an error.
  public func currentlyPlaying(accessToken: String) async throws -> PlaybackState? {
    let url = URL(string: "https://api.spotify.com/v1/me/player/currently-playing")!
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if http.statusCode == 204 { return nil }
    if http.statusCode == 401 { throw SpotifyError.unauthorized }
    guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    return Self.parsePlayback(data)
  }

  public static func parsePlayback(_ data: Data) -> PlaybackState? {
    struct Payload: Decodable {
      let progress_ms: Double?
      let is_playing: Bool?
      let item: Item?
      struct Item: Decodable {
        let id: String?
        let name: String?
        let duration_ms: Double?
        let artists: [Artist]?
        let album: Album?
      }
      struct Artist: Decodable { let name: String? }
      struct Album: Decodable {
        let name: String?
        let images: [Image]?
      }
      struct Image: Decodable {
        let url: String?
        let width: Int?
      }
    }
    guard let payload = try? JSONDecoder().decode(Payload.self, from: data),
          let item = payload.item,
          let title = item.name, !title.isEmpty
    else { return nil }

    // Spotify orders album images LARGEST first, so images[1] is the 300px
    // rendition — too small for a poster on a 2× panel. Take the 640.
    let artwork = item.album?.images?.first?.url

    return PlaybackState(
      item: CatalogItem(
        // Deliberately not Spotify's track id: everything downstream treats a
        // non-empty id as an *Apple Music catalog* id and will try to resolve
        // it for playback. Following is not playing; leave it blank so the
        // title/artist path is the only one available.
        id: "",
        title: title,
        artist: (item.artists ?? []).compactMap(\.name).joined(separator: ", "),
        album: item.album?.name,
        artworkURL: artwork.flatMap { URL(string: $0) },
        duration: item.duration_ms.map { $0 / 1000 }
      ),
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
    case .unauthorized:
      return "Spotify rejected the sign-in. Connect again."
    case .notDeployed:
      return "This server doesn’t have the Spotify pairing endpoints yet. Deploy the latest build of the site, then try again."
    case .server(let message):
      return message
    case .http(let status):
      return "The pairing server returned an error (\(status))."
    }
  }
}
