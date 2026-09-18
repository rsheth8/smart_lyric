import Foundation
import MusicKit

/// Love / library writes that MusicKit does not expose as first-class methods.
///
/// Ratings use the Apple Music API through `MusicDataRequest`, so the user
/// token MusicKit already holds is attached automatically. A `1` is Love —
/// the same heart as Music — and deleting the rating removes it.
enum AppleMusicSocial {
  struct RatingPayload: Decodable {
    var data: [Item]
    struct Item: Decodable {
      var attributes: Attributes
      struct Attributes: Decodable { var value: Int }
    }
    var value: Int? { data.first?.attributes.value }
  }

  static func ratingURL(songID: String) -> URL? {
    let id = songID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? songID
    return URL(string: "https://api.music.apple.com/v1/me/ratings/songs/\(id)")
  }

  static func parseRating(from data: Data) -> Int? {
    (try? JSONDecoder().decode(RatingPayload.self, from: data))?.value
  }

  static func isLoved(songID: String) async -> Bool {
    guard let url = ratingURL(songID: songID) else { return false }
    do {
      let response = try await MusicDataRequest(urlRequest: URLRequest(url: url)).response()
      return parseRating(from: response.data) == 1
    } catch {
      return false
    }
  }

  static func setLoved(_ loved: Bool, songID: String) async throws {
    guard let url = ratingURL(songID: songID) else { return }
    var request = URLRequest(url: url)
    if loved {
      request.httpMethod = "PUT"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data(#"{"type":"rating","attributes":{"value":1}}"#.utf8)
    } else {
      request.httpMethod = "DELETE"
    }
    _ = try await MusicDataRequest(urlRequest: request).response()
  }
}

/// Repeat is a three-way cycle, same as Music: off → all → one → off.
enum RepeatCycle: String, Equatable {
  case off, all, one

  var next: RepeatCycle {
    switch self {
    case .off: return .all
    case .all: return .one
    case .one: return .off
    }
  }

  var label: String {
    switch self {
    case .off: return "Repeat off"
    case .all: return "Repeat all"
    case .one: return "Repeat one"
    }
  }

  var systemImage: String {
    switch self {
    case .off: return "repeat"
    case .all: return "repeat"
    case .one: return "repeat.1"
    }
  }

  init(_ mode: MusicPlayer.RepeatMode?) {
    switch mode {
    case .one: self = .one
    case .all: self = .all
    default: self = .off
    }
  }

  var musicKit: MusicPlayer.RepeatMode {
    switch self {
    case .off: return .none
    case .all: return .all
    case .one: return .one
    }
  }
}

enum PlaybackSkip {
  /// Music's previous-track rule: past this, Previous restarts the song.
  static let restartThreshold: TimeInterval = 3
  static let nudge: TimeInterval = 15

  static func shouldRestartCurrent(at time: TimeInterval) -> Bool {
    time > restartThreshold
  }

  static func clamped(time: TimeInterval, delta: TimeInterval, duration: TimeInterval?) -> TimeInterval {
    let upper = duration.flatMap { $0 > 0 ? $0 : nil } ?? .greatestFiniteMagnitude
    return min(max(0, time + delta), upper)
  }
}
