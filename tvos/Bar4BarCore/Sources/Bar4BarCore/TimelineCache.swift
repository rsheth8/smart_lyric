import Foundation

/// Disk cache for timelines, keyed like the JS timeline-cache (artist|track|duration bucket).
public struct TimelineCache: Sendable {
  public var directory: URL

  public init(directory: URL? = nil) {
    if let directory {
      self.directory = directory
    } else {
      let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory
      self.directory = base.appendingPathComponent("Bar4BarTimelines", isDirectory: true)
    }
    try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
  }

  public static func cacheKey(artist: String, track: String, duration: Double?) -> String {
    let a = TitleMatch.primaryArtist(artist).lowercased()
    let t = TitleMatch.cleanTrackTitle(track).lowercased()
    let d: String
    if let duration, duration > 0 {
      d = String(Int((duration / 5).rounded() * 5))
    } else {
      d = "na"
    }
    let raw = "\(a)|\(t)|\(d)"
    return raw
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
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
