import Foundation
import Combine
import Bar4BarCore

/// Spotify follow-mode for the Apple TV.
///
/// Owns pairing, the refresh-token lifecycle, the follow poll, and remote
/// transport. The TV never plays Spotify audio — pause/skip/seek go to whatever
/// phone, speaker, or computer is already playing.
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
  @Published private(set) var connectionMessage: String?
  /// Catalog metadata for the track Spotify will play next, when the queue is known.
  @Published private(set) var nextUp: CatalogItem?
  private var lifecycleID = UUID()
  private var lastTrackID: String?
  private var lastQueueRefresh: TimeInterval?

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

  /// Base follow-poll. Speeds up in the last 25 s so a track change is not a
  /// full second late — same schedule as the desktop follow client.
  private var pollInterval: TimeInterval = 1

  init() { configure(apiBase: AppConfig.lyricsAPIBase) }

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
    guard pairTask == nil, followTask == nil, state == .disconnected else { return }
    guard client != nil, let refresh = Keychain.read(Self.refreshKey) else { return }
    let id = lifecycleID
    state = .connecting
    if await refreshAccess(using: refresh) {
      guard lifecycleID == id, !Task.isCancelled else { return }
      state = .connected
      startFollowing()
    } else {
      guard lifecycleID == id, !Task.isCancelled else { return }
      state = .failed("Couldn’t reconnect to Spotify. Check your connection and try again.")
    }
  }

  func connect() async {
    guard state == .disconnected else { return }
    if Keychain.read(Self.refreshKey) != nil { await restore() }
    else { startPairing() }
  }

  // MARK: - Pairing

  func startPairing() {
    guard let client else {
      state = .failed("No server configured. Set LYRICS_API_BASE to your deployment.")
      return
    }
    pairTask?.cancel()
    lifecycleID = UUID()
    let id = lifecycleID
    state = .connecting
    storeWarning = nil
    scanURL = nil

    pairTask = Task { [weak self] in
      guard let self else { return }
      do {
        let pairing = try await client.startPairing()
        guard !Task.isCancelled, lifecycleID == id else { return }
        // Non-durable store: warn but proceed — works on a local dev server
        // (same process, memory is shared). On a serverless deployment without
        // KV the poll will time-out rather than succeed; the warning says why.
        if !pairing.durable {
          storeWarning = "Pairing may be unreliable — the server has no persistent store configured."
        }
        scanURL = pairing.scanURL
        state = .pairing(code: pairing.code, verifyURL: Self.displayURL(pairing.verifyURL))

        // Poll until the phone finishes, or the code dies of old age.
        let deadline = Date().addingTimeInterval(pairing.expiresIn)
        while !Task.isCancelled, Date() < deadline {
          try? await Task.sleep(for: .seconds(2))
          guard !Task.isCancelled, lifecycleID == id else { return }
          let result = await client.pollPairing(token: pairing.pollToken)
          guard !Task.isCancelled, lifecycleID == id else { return }
          switch result {
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
        guard !Task.isCancelled, lifecycleID == id else { return }
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
    lifecycleID = UUID()
    pairTask?.cancel()
    pairTask = nil
    if case .connected = state {} else { state = .disconnected }
  }

  func disconnect() {
    lifecycleID = UUID()
    pairTask?.cancel(); pairTask = nil
    followTask?.cancel(); followTask = nil
    Keychain.delete(Self.refreshKey)
    accessToken = nil
    accessExpiry = .distantPast
    clock = nil
    followClock = nil
    lastTrackID = nil
    lastQueueRefresh = nil
    connectionMessage = nil
    track = nil
    nextUp = nil
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
        try? await Task.sleep(for: .seconds(self?.pollInterval ?? 1))
      }
    }
  }

  private func pollOnce() async {
    let id = lifecycleID
    guard let client else { return }
    guard await ensureFreshAccess(), let token = accessToken, lifecycleID == id, !Task.isCancelled else { return }

    do {
      let playback = try await client.currentlyPlaying(accessToken: token)
      guard lifecycleID == id, !Task.isCancelled else { return }
      guard let playback else {
        // Nothing playing anywhere. Keep the connection, drop the track.
        clock?.set(clock?.now() ?? 0)
        isPlaying = false
        track = nil
        nextUp = nil
        lastTrackID = nil
        lastQueueRefresh = nil
        pollInterval = 1
        return
      }
      connectionMessage = nil
      let changed = playback.trackID != lastTrackID || track != playback.item
      let transportChanged = isPlaying != playback.isPlaying
      isPlaying = playback.isPlaying
      if changed || transportChanged { clock?.set(playback.progress) }
      else { clock?.observe(playback.progress) }
      lastTrackID = playback.trackID
      if track != playback.item { track = playback.item }
      let remaining = playback.item.duration.map { $0 - playback.progress }
      pollInterval = SpotifyClient.followPollInterval(remaining: remaining, isPlaying: playback.isPlaying)
      if changed {
        nextUp = nil
        lastQueueRefresh = nil
      }
      refreshQueueIfNeeded(token: token, remaining: remaining, lifecycle: id)
    } catch SpotifyError.rateLimited(let seconds) {
      guard lifecycleID == id, !Task.isCancelled else { return }
      connectionMessage = "Spotify is busy. Reconnecting shortly…"
      try? await Task.sleep(for: .seconds(seconds))
    } catch SpotifyError.unauthorized {
      guard lifecycleID == id, !Task.isCancelled else { return }
      // The access token died early. One refresh, then let the next tick retry.
      if let refresh = Keychain.read(Self.refreshKey) {
        _ = await refreshAccess(using: refresh)
      } else {
        state = .failed("Spotify sign-in expired. Connect again.")
        followTask?.cancel()
      }
    } catch {
      guard lifecycleID == id, !Task.isCancelled else { return }
      clock?.set(clock?.now() ?? 0)
      isPlaying = false
      connectionMessage = "Connection interrupted. Trying again…"
    }
  }

  private func refreshQueueIfNeeded(token: String, remaining: Double?, lifecycle: UUID) {
    let now = ProcessInfo.processInfo.systemUptime
    guard NextPrep.shouldRefreshQueue(lastRefresh: lastQueueRefresh, remaining: remaining, now: now) else {
      return
    }
    lastQueueRefresh = now
    Task { [weak self] in
      await self?.refreshQueue(token: token, lifecycle: lifecycle)
    }
  }

  private func refreshQueue(token: String, lifecycle: UUID) async {
    guard let client, lifecycleID == lifecycle, !Task.isCancelled else { return }
    do {
      let next = try await client.nextInQueue(accessToken: token)
      guard lifecycleID == lifecycle, !Task.isCancelled else { return }
      if nextUp != next {
        nextUp = next
        if let next {
          TVLog.spotify("queue next: \(next.title) — \(next.artist)")
        } else {
          TVLog.spotify("queue next: empty")
        }
      }
    } catch SpotifyError.unauthorized {
      TVLog.spotify("queue refresh unauthorized — re-pair if this keeps happening")
    } catch SpotifyError.rateLimited(let seconds) {
      TVLog.spotify("queue rate-limited, retry in \(Int(seconds))s")
      lastQueueRefresh = ProcessInfo.processInfo.systemUptime + max(0, seconds - 8)
    } catch {
      TVLog.spotify("queue refresh failed: \(error.localizedDescription)")
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
    let id = lifecycleID
    do {
      let tokens = try await client.refresh(refreshToken: refreshToken)
      guard lifecycleID == id, !Task.isCancelled else { return false }
      accessToken = tokens.accessToken
      accessExpiry = Date().addingTimeInterval(tokens.expiresIn - 60)
      // Spotify sometimes rotates the refresh token; store whatever came back.
      Keychain.write(Self.refreshKey, tokens.refreshToken)
      return true
    } catch SpotifyError.unauthorized {
      guard lifecycleID == id, !Task.isCancelled else { return false }
      Keychain.delete(Self.refreshKey)
      accessToken = nil
      clock?.set(clock?.now() ?? 0)
      isPlaying = false
      track = nil
      state = .failed("Spotify sign-in expired. Connect again.")
      followTask?.cancel()
      followTask = nil
      return false
    } catch {
      guard lifecycleID == id, !Task.isCancelled else { return false }
      clock?.set(clock?.now() ?? 0)
      isPlaying = false
      connectionMessage = "Couldn’t reconnect. Trying again…"
      try? await Task.sleep(for: .seconds(5))
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

/// Pause / skip / seek on the account's active Spotify device.
@MainActor
protocol SpotifyRemoteControlling: AnyObject {
  func remoteTogglePlayPause() async -> String?
  func remoteSkipNext() async -> String?
  func remoteSkipPrevious() async -> String?
  func remoteSeek(to time: TimeInterval) async -> String?
}

extension SpotifyService: SpotifyRemoteControlling {
  func remoteTogglePlayPause() async -> String? {
    await sendControl(isPlaying ? .pause : .play) {
      self.isPlaying.toggle()
      self.clock?.set(self.clock?.now() ?? 0)
    }
  }

  func remoteSkipNext() async -> String? {
    await sendControl(.next)
  }

  func remoteSkipPrevious() async -> String? {
    await sendControl(.previous)
  }

  func remoteSeek(to time: TimeInterval) async -> String? {
    let ms = Int((max(0, time) * 1000).rounded())
    return await sendControl(.seekMs(ms)) {
      self.clock?.set(max(0, time))
    }
  }

  private func sendControl(
    _ command: SpotifyClient.PlayerCommand,
    afterSuccess: (() -> Void)? = nil
  ) async -> String? {
    guard let client else { return "Spotify is not connected." }
    guard await ensureFreshAccess(), let token = accessToken else {
      return "Spotify sign-in expired. Connect again."
    }
    do {
      try await client.sendPlayerCommand(command, accessToken: token)
      afterSuccess?()
      await pollOnce()
      return nil
    } catch {
      return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
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
