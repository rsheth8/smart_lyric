import Foundation

/// Recording identity is separate from the Apple Music ID used for playback.
/// A shared title or ISRC must never override conflicting provider IDs/editions.
public struct RecordingIdentity: Equatable, Hashable, Sendable, Codable {
  public var spotifyID: String?
  public var appleMusicID: String?
  public var isrc: String?
  public var explicit: Bool?

  public init(spotifyID: String? = nil, appleMusicID: String? = nil,
              isrc: String? = nil, explicit: Bool? = nil) {
    self.spotifyID = spotifyID
    self.appleMusicID = appleMusicID
    self.isrc = isrc?.uppercased()
    self.explicit = explicit
  }

  public var hasIdentifier: Bool {
    [spotifyID, appleMusicID, isrc].contains { !($0 ?? "").isEmpty }
  }

  public func matches(_ candidate: RecordingIdentity?) -> Bool {
    guard let candidate, hasIdentifier, candidate.hasIdentifier else { return false }
    if let explicit, let other = candidate.explicit, explicit != other { return false }
    var sharedID = false
    for (a, b) in [(spotifyID, candidate.spotifyID), (appleMusicID, candidate.appleMusicID)] {
      if let a, !a.isEmpty, let b, !b.isEmpty {
        guard a == b else { return false }
        sharedID = true
      }
    }
    if let isrc, !isrc.isEmpty, let other = candidate.isrc, !other.isEmpty,
       isrc.uppercased() != other.uppercased() { return false }
    if sharedID { return true }
    // Cross-provider matching needs the recording code AND a known edition.
    return !(isrc ?? "").isEmpty && isrc?.uppercased() == candidate.isrc?.uppercased()
      && explicit != nil && explicit == candidate.explicit
  }

  public var queryItems: [URLQueryItem] {
    [spotifyID.map { URLQueryItem(name: "spotifyID", value: $0) },
     appleMusicID.map { URLQueryItem(name: "appleMusicID", value: $0) },
     isrc.map { URLQueryItem(name: "isrc", value: $0) },
     explicit.map { URLQueryItem(name: "explicit", value: $0 ? "true" : "false") }].compactMap { $0 }
  }
}
