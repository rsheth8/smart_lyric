import Foundation
import CryptoKit

/// Separate recording editions, preserving full titles and exact duration.
public struct TimelineCache: Sendable {
  public var directory: URL

  public init(directory: URL? = nil) {
    if let directory {
      self.directory = directory
    } else {
      let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory
      self.directory = base.appendingPathComponent("Bar4BarTimelines-v3", isDirectory: true)
    }
    try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
  }

  public static func cacheKey(artist: String, track: String, duration: Double?,
                              album: String? = nil, recording: RecordingIdentity? = nil) -> String {
    // JSON encoding avoids delimiter collisions; hashing avoids unsafe/long filenames.
    let durationText: String = duration.map { String($0) } ?? ""
    let explicitText: String = recording?.explicit.map { String($0) } ?? ""
    let fields: [String] = [artist, track, album ?? "", durationText,
                           recording?.spotifyID ?? "", recording?.appleMusicID ?? "",
                           recording?.isrc?.uppercased() ?? "", explicitText]
    let data = (try? JSONEncoder().encode(fields)) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  public func load(key: String) -> Timeline? {
    let url = directory.appendingPathComponent(key).appendingPathExtension("json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Timeline.self, from: data)
  }

  public func save(_ timeline: Timeline, key: String) {
    let url = directory.appendingPathComponent(key).appendingPathExtension("json")
    guard let data = try? JSONEncoder().encode(timeline) else { return }
    try? data.write(to: url, options: .atomic)
  }
}
