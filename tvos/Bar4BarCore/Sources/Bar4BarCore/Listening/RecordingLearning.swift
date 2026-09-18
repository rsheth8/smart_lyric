import Foundation
import CryptoKit

public struct RecordingLearningProfile: Codable, Sendable {
  public struct Candidate: Codable, Sendable {
    public var play: UUID
    public var word: LearnedWord
  }
  public var version = 1
  public var recording: RecordingIdentity
  public var cacheKey: String
  public var lyricRevision: String
  public var referenceVersion: String?
  public private(set) var candidates: [Candidate] = []
  public private(set) var accepted: [LearnedWord] = []
  public private(set) var previous: [LearnedWord] = []
  public init(context: ListeningContext) {
    recording = context.recording; cacheKey = context.cacheKey; lyricRevision = context.lyricRevision
    referenceVersion = context.referenceVersion
  }
  public func matches(_ context: ListeningContext) -> Bool {
    version == 1 && recording == context.recording && cacheKey == context.cacheKey
      && lyricRevision == context.lyricRevision && referenceVersion == context.referenceVersion
  }
  /// A window cannot create another play. Bad new plays leave the stronger accepted profile intact.
  public mutating func add(_ words: [LearnedWord], play: UUID) {
    for word in words where word.start.isFinite && word.end.isFinite && word.start >= 0
      && word.end > word.start && word.uncertainty <= 0.1 && word.address.line >= 0 && word.address.word >= 0 {
      candidates.removeAll { $0.play == play && $0.word.address == word.address && $0.word.absolute == word.absolute }
      candidates.append(Candidate(play: play, word: word))
      let matching = candidates.filter { $0.word.address == word.address && $0.word.absolute == word.absolute }
      // Three mutually agreeing distinct plays are required; outliers are not averaged into trusted guidance.
      let inliers = matching.filter { abs($0.word.start - word.start) <= 0.1 }
      guard Set(inliers.map(\.play)).count >= 3,
        (inliers.map { $0.word.start }.max() ?? 0) - (inliers.map { $0.word.start }.min() ?? 0) <= 0.1,
        (inliers.map { $0.word.end }.max() ?? 0) - (inliers.map { $0.word.end }.min() ?? 0) <= 0.15 else { continue }
      var promoted = word
      promoted.start = ListeningMath.median(inliers.map { $0.word.start })
      promoted.end = ListeningMath.median(inliers.map { $0.word.end })
      promoted.supportingPlays = Set(inliers.map(\.play)).count
      promoted.uncertainty = max(inliers.map { abs($0.word.start - promoted.start) }.max() ?? 0,
        inliers.map { $0.word.uncertainty }.max() ?? 0)
      if let old = accepted.first(where: { $0.address == word.address }) {
        guard (!old.absolute || promoted.absolute), abs(old.start - promoted.start) <= 0.1,
          promoted.uncertainty <= old.uncertainty else { continue }
      }
      previous = accepted
      accepted.removeAll { $0.address == word.address }
      accepted.append(promoted)
    }
    // Bound recording storage even after hundreds of repeated plays.
    if candidates.count > 30000 { candidates.removeFirst(candidates.count - 30000) }
  }
  public mutating func rollback() { let current = accepted; accepted = previous; previous = current }

  public func applying(to base: Timeline, protected: Set<LyricAddress> = [], afterLine: Int = -1) -> Timeline {
    var result = base
    for value in accepted where value.address.line > afterLine && !protected.contains(value.address) {
      let a = value.address
      guard result.lines.indices.contains(a.line), result.lines[a.line].words.indices.contains(a.word) else { continue }
      let origin = value.absolute ? 0 : base.lines[a.line].words.first?.start ?? base.lines[a.line].start
      let start = origin + value.start, end = origin + value.end
      guard start >= 0, end > start, end <= base.duration else { continue }
      result.lines[a.line].words[a.word].start = start
      result.lines[a.line].words[a.word].end = end
      // Personal learned guidance remains approximate. Only the reviewed publication workflow can certify it.
      result.lines[a.line].words[a.word].timingQuality = .estimated
    }
    for index in result.lines.indices {
      let words = result.lines[index].words
      guard zip(words, words.dropFirst()).allSatisfy({ $0.start <= $1.start }),
        let first = words.first, let last = words.last else { result.lines[index] = base.lines[index]; continue }
      result.lines[index].start = first.start; result.lines[index].end = last.end
    }
    // Do not let updates reverse phrase order or turn a following phrase into the current phrase.
    for index in result.lines.indices where index > 0 {
      if result.lines[index].start < result.lines[index - 1].start { return base }
    }
    return result
  }
}

public struct RecordingLearningStore: Sendable {
  public let directory: URL
  public init(directory: URL? = nil) {
    self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Bar4BarLearning-v1", isDirectory: true)
  }
  private func url(_ context: ListeningContext) -> URL {
    let data = Data([context.cacheKey, context.lyricRevision, context.referenceVersion ?? ""].joined(separator: "\u{1f}").utf8)
    let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(key).appendingPathExtension("json")
  }
  public func load(_ context: ListeningContext) -> RecordingLearningProfile? {
    guard let data = try? Data(contentsOf: url(context)), data.count < 20_000_000,
      let profile = try? JSONDecoder().decode(RecordingLearningProfile.self, from: data), profile.matches(context) else { return nil }
    return profile
  }
  public func save(_ profile: RecordingLearningProfile, context: ListeningContext) throws {
    guard profile.matches(context) else { throw CocoaError(.fileWriteInvalidFileName) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(profile).write(to: url(context), options: .atomic)
  }
  public func reset(_ context: ListeningContext) throws {
    if FileManager.default.fileExists(atPath: url(context).path) { try FileManager.default.removeItem(at: url(context)) }
  }
}
