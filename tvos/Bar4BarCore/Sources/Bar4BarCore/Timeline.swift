import Foundation

/// A single sung word with absolute song-time bounds (seconds).
public struct LyricWord: Equatable, Sendable, Codable {
  public var text: String
  public var start: Double
  public var end: Double
  /// CTC / catalog confidence; `nil` means trust fully (catalog / estimate).
  public var score: Double?

  public init(text: String, start: Double, end: Double, score: Double? = nil) {
    self.text = text
    self.start = start
    self.end = end
    self.score = score
  }
}

/// A lyric line with word spans.
public struct LyricLine: Equatable, Sendable, Codable {
  public var start: Double
  public var end: Double
  public var words: [LyricWord]
  public var agent: String?
  public var uncertain: Bool

  public init(
    start: Double,
    end: Double,
    words: [LyricWord],
    agent: String? = nil,
    uncertain: Bool = false
  ) {
    self.start = start
    self.end = end
    self.words = words
    self.agent = agent
    self.uncertain = uncertain
  }

  public var text: String {
    words.map(\.text).joined(separator: " ")
  }
}

/// Canonical karaoke timeline shared by every format parser and the display.
public struct Timeline: Equatable, Sendable, Codable {
  public var lines: [LyricLine]
  public var duration: Double
  public var estimated: Bool
  public var source: String?

  public init(
    lines: [LyricLine],
    duration: Double = 0,
    estimated: Bool = false,
    source: String? = nil
  ) {
    self.lines = lines
    self.duration = duration > 0
      ? duration
      : (lines.last?.end ?? 0)
    self.estimated = estimated
    self.source = source
  }

  public var isEmpty: Bool { lines.isEmpty }
}

/// Metadata attached to a catalog lyric hit (used by preferResult / match).
public struct LyricsMeta: Equatable, Sendable, Codable {
  public var duration: Double?
  public var artist: String?
  public var track: String?
  public var album: String?

  public init(
    duration: Double? = nil,
    artist: String? = nil,
    track: String? = nil,
    album: String? = nil
  ) {
    self.duration = duration
    self.artist = artist
    self.track = track
    self.album = album
  }
}

/// One provider result before orchestration picks a winner.
public struct LyricsResult: Equatable, Sendable {
  public var timeline: Timeline
  public var meta: LyricsMeta
  /// Preference rank: lower = richer (0 = word-level, 1 = line, 2 = plain).
  public var richness: Int

  public init(timeline: Timeline, meta: LyricsMeta = LyricsMeta(), richness: Int = 1) {
    self.timeline = timeline
    self.meta = meta
    self.richness = richness
  }
}
