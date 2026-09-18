import Foundation

/// Catalog prefetch for the track that will play next.
///
/// This is not alignment. Spotify and Apple Music do not give the next
/// recording to a server, so the only work that can finish early is the same
/// catalog fetch the karaoke session would run on track change.
public enum NextPrep {
  /// True when both sides name the same recording. IDs win; title is fallback.
  public static func sameTrack(
    leftID: String?,
    leftRecording: RecordingIdentity?,
    leftArtist: String,
    leftTitle: String,
    rightID: String?,
    rightRecording: RecordingIdentity?,
    rightArtist: String,
    rightTitle: String
  ) -> Bool {
    if let leftRecording, leftRecording.hasIdentifier,
       let rightRecording, rightRecording.hasIdentifier {
      if leftRecording.matches(rightRecording) { return true }
      if conflicting(leftRecording, rightRecording) { return false }
    }
    if let left = nonempty(leftID), let right = nonempty(rightID), left == right { return true }
    return fold(leftArtist) == fold(rightArtist) && fold(leftTitle) == fold(rightTitle)
  }

  /// Queue lookup is cheaper than a lyric fetch, but it still shares Spotify's
  /// rate budget with currently-playing. Refresh every few seconds, faster
  /// when the current song is about to end so Autoplay has time to fill.
  public static func shouldRefreshQueue(
    lastRefresh: TimeInterval?,
    remaining: Double?,
    now: TimeInterval,
    interval: TimeInterval = 8,
    urgentRemaining: TimeInterval = 45,
    urgentInterval: TimeInterval = 3
  ) -> Bool {
    guard let lastRefresh else { return true }
    let elapsed = now - lastRefresh
    guard elapsed >= 0 else { return true }
    if let remaining, remaining.isFinite, remaining > 0, remaining < urgentRemaining {
      return elapsed >= urgentInterval
    }
    return elapsed >= interval
  }

  /// Head of `GET /me/player/queue`. Nil when Autoplay has not filled yet.
  public static func parseQueueHead(_ data: Data) -> CatalogItem? {
    struct Payload: Decodable {
      let queue: [SpotifyTrackItem]?
    }
    guard let payload = try? JSONDecoder().decode(Payload.self, from: data),
          let item = payload.queue?.first
    else { return nil }
    return item.catalogItem()
  }

  private static func conflicting(_ left: RecordingIdentity, _ right: RecordingIdentity) -> Bool {
    for (a, b) in [(left.spotifyID, right.spotifyID), (left.appleMusicID, right.appleMusicID)] {
      if let a, !a.isEmpty, let b, !b.isEmpty, a != b { return true }
    }
    return false
  }

  private static func fold(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private static func nonempty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
  }
}

/// Shared Spotify track JSON for currently-playing and the play queue.
struct SpotifyTrackItem: Decodable {
  let id: String?
  let name: String?
  let duration_ms: Double?
  let explicit: Bool?
  let external_ids: ExternalIDs?
  let artists: [Artist]?
  let album: Album?

  struct ExternalIDs: Decodable { let isrc: String? }
  struct Artist: Decodable { let name: String? }
  struct Album: Decodable {
    let name: String?
    let images: [Image]?
  }
  struct Image: Decodable {
    let url: String?
    let width: Int?
  }

  func catalogItem() -> CatalogItem? {
    guard let title = name, !title.isEmpty else { return nil }
    return CatalogItem(
      id: "",
      title: title,
      artist: (artists ?? []).compactMap(\.name).joined(separator: ", "),
      album: album?.name,
      artworkURL: album?.images?.first?.url.flatMap(URL.init(string:)),
      duration: duration_ms.map { $0 / 1000 },
      recording: RecordingIdentity(spotifyID: id, isrc: external_ids?.isrc, explicit: explicit)
    )
  }
}
