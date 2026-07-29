import Foundation
import Combine
import Bar4BarCore

/// Spotify follow-mode for the Apple TV.
///
/// Owns three things: the phone-pairing handshake, the refresh-token lifecycle,
/// and a poll loop that keeps a `StreamingClock` honest. It never plays audio —
/// the TV follows whatever the account is already playing somewhere else.
///
/// The clock matters more than it looks. Spotify reports `progress_ms` about
/// once a second with network jitter on top, and driving the lyric display
/// straight off that would make every word twitch. `StreamingClock` free-runs
/// between polls and eases toward each observation, which is the same treatment
/// the Electron follow-poll uses.
@MainActor
final class SpotifyService: ObservableObject {

  enum State: Equatable {
    case disconnected
    case pairing(code: String, verifyURL: String)
    case connecting
    case connected
    case failed(String)
  }

  @Published private(set) var state: State = .disconnected
  @Published private(set) var track: CatalogItem?
  @Published private(set) var isPlaying = false
  /// Set when the deployment has no shared store, which makes pairing unreliable.
  @Published private(set) var storeWarning: String?
  /// URL behind the QR code — goes straight to Spotify with the code applied.
  @Published private(set) var scanURL: String?

  var isConnected: Bool {
    if case .connected = state { return true }
    return false
  }

  private var client: SpotifyClient?
  private var pairTask: Task<Void, Never>?
  private var followTask: Task<Void, Never>?

  private var accessToken: String?
  private var accessExpiry: Date = .distantPast
  private var clock: StreamingClock?

  private static let refreshKey = "bar4bar.spotify.refresh"

  /// How often we ask Spotify what is playing. A second is the rhythm the web
  /// app settled on: fast enough that a track change lands within a line, slow
  /// enough to stay far under the rate limit on a device left on all evening.
  private let pollInterval: Duration = .seconds(1)

  // MARK: - Setup

  func configure(apiBase: URL?) {
    guard let apiBase else {
      state = .failed("No server configured. Set LYRICS_API_BASE to your deployment.")
      return
    }
    client = SpotifyClient(apiBaseURL: apiBase)
  }

  /// Reconnect silently on launch if a refresh token survived.
  func restore() async {
    guard client != nil, let refresh = Keychain.read(Self.refreshKey) else { return }
    state = .connecting
    if await refreshAccess(using: refresh) {
      state = .connected
      startFollowing()
    } else {
      Keychain.delete(Self.refreshKey)
      state = .disconnected
    }
  }

  // MARK: - Pairing

  func startPairing() {
    guard let client else {
      state = .failed("No server configured. Set LYRICS_API_BASE to your deployment.")
      return
    }
    pairTask?.cancel()
    state = .connecting
    storeWarning = nil

    pairTask = Task { [weak self] in
      guard let self else { return }
      do {
        let pairing = try await client.startPairing()
        guard !Task.isCancelled else { return }
        if !pairing.durable {
          storeWarning = "This server has no shared store bound, so pairing may not complete. See docs/tvos-migration.md."
        }
        scanURL = pairing.scanURL
        state = .pairing(code: pairing.code, verifyURL: Self.displayURL(pairing.verifyURL))

        // Poll until the phone finishes, or the code dies of old age.
        let deadline = Date().addingTimeInterval(pairing.expiresIn)
        while !Task.isCancelled, Date() < deadline {
          try? await Task.sleep(for: .seconds(2))
          guard !Task.isCancelled else { return }
          switch await client.pollPairing(token: pairing.pollToken) {
          case .pending:
            continue
          case .expired:
            state = .failed("That code expired before it was used. Try again.")
            return
          case .ready(let tokens):
            Keychain.write(Self.refreshKey, tokens.refreshToken)
            accessToken = tokens.accessToken
            accessExpiry = Date().addingTimeInterval(tokens.expiresIn - 60)
            state = .connected
            startFollowing()
            return
          }
        }
        if !Task.isCancelled {
          state = .failed("That code expired before it was used. Try again.")
        }
      } catch {
        state = .failed(error.localizedDescription)
      }
    }
  }

  /// Layout harness — parks the screen on its code state without a server.
  /// Behind `BAR4BAR_FAKE_PAIR`; nothing calls it in a shipping launch.
  func showPlaceholderPairing(code: String, verifyURL: String = "smartlyric.vercel.app/tv") {
    pairTask?.cancel()
    scanURL = "https://\(verifyURL.replacingOccurrences(of: "/tv", with: ""))/api/tv-pair?action=authorize&code=\(code)"
    state = .pairing(code: code, verifyURL: verifyURL)
  }

  func cancelPairing() {
    pairTask?.cancel()
    pairTask = nil
    if case .connected = state {} else { state = .disconnected }
  }

  func disconnect() {
    pairTask?.cancel(); pairTask = nil
    followTask?.cancel(); followTask = nil
    Keychain.delete(Self.refreshKey)
    accessToken = nil
    accessExpiry = .distantPast
    clock = nil
    track = nil
    isPlaying = false
    state = .disconnected
  }

  // MARK: - Following

  /// The clock the karaoke display should read while Spotify is the source.
  private(set) var followClock: StreamingClock?

  private func startFollowing() {
    followTask?.cancel()
    let clock = StreamingClock(
      isPlaying: { [weak self] in self?.isPlaying ?? false }
    )
    self.clock = clock
    self.followClock = clock

    followTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.pollOnce()
        try? await Task.sleep(for: self?.pollInterval ?? .seconds(1))
      }
    }
  }

  private func pollOnce() async {
    guard let client else { return }
    guard await ensureFreshAccess(), let token = accessToken else { return }

    do {
      guard let playback = try await client.currentlyPlaying(accessToken: token) else {
        // Nothing playing anywhere. Keep the connection, drop the track.
        isPlaying = false
        return
      }
      isPlaying = playback.isPlaying
      if track != playback.item { track = playback.item }
      clock?.observe(playback.progress)
    } catch SpotifyError.unauthorized {
      // The access token died early. One refresh, then let the next tick retry.
      if let refresh = Keychain.read(Self.refreshKey) {
        _ = await refreshAccess(using: refresh)
      } else {
        state = .failed("Spotify sign-in expired. Connect again.")
        followTask?.cancel()
      }
    } catch {
      // A dropped poll is not worth surfacing — the next one is a second away.
    }
  }

  // MARK: - Tokens

  private func ensureFreshAccess() async -> Bool {
    if accessToken != nil, Date() < accessExpiry { return true }
    guard let refresh = Keychain.read(Self.refreshKey) else { return false }
    return await refreshAccess(using: refresh)
  }

  private func refreshAccess(using refreshToken: String) async -> Bool {
    guard let client else { return false }
    do {
      let tokens = try await client.refresh(refreshToken: refreshToken)
      accessToken = tokens.accessToken
      accessExpiry = Date().addingTimeInterval(tokens.expiresIn - 60)
      // Spotify sometimes rotates the refresh token; store whatever came back.
      Keychain.write(Self.refreshKey, tokens.refreshToken)
      return true
    } catch {
      return false
    }
  }

  /// Trim the URL for display: a viewer typing it off a TV does not need the
  /// scheme, and "https://" across a room is three seconds of nothing.
  private static func displayURL(_ raw: String) -> String {
    raw.replacingOccurrences(of: "https://", with: "")
      .replacingOccurrences(of: "http://", with: "")
  }
}

// MARK: - Keychain

/// Minimal Keychain wrapper for the one secret this app holds.
///
/// `UserDefaults` would have been fewer lines, but a Spotify refresh token is a
/// long-lived credential for someone's music account and belongs behind the
/// system's own protection, not in a plist inside the app container.
enum Keychain {
  private static let service = "com.bar4bar.tv"

  static func write(_ key: String, _ value: String) {
    delete(key)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecValueData as String: Data(value.utf8),
      // The Apple TV has no passcode, so the device-unlocked classes do not
      // apply; this is the tightest class that still survives a reboot.
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    SecItemAdd(query as CFDictionary, nil)
  }

  static func read(_ key: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func delete(_ key: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
