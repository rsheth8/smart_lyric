import Foundation

public enum StageIntensity: String, Codable, CaseIterable, Sendable {
  case focus, live, headliner
  public var strength: Double { self == .focus ? 0.18 : self == .live ? 0.6 : 1 }
}

public enum WordTimingQuality: String, Codable, Sendable { case estimated, reliable }

public extension Timeline {
  /// Stable across timing and translation revisions, distinct for different lyric text.
  var lyricRevision: String {
    var hash: UInt64 = 14695981039346656037
    for byte in lines.map({ $0.words.map(\.text).joined(separator: "\u{1F}") }).joined(separator: "\u{1E}").utf8 {
      hash = (hash ^ UInt64(byte)) &* 1099511628211
    }
    return String(hash, radix: 16)
  }

  func quality(line: Int, word: Int) -> WordTimingQuality {
    guard lines.indices.contains(line), lines[line].words.indices.contains(word) else { return .estimated }
    let token = lines[line].words[word]
    if let quality = token.timingQuality { return quality }
    if let score = token.score { return score >= 0.7 ? .reliable : .estimated }
    return hasWordTiming && !lines[line].uncertain ? .reliable : .estimated
  }
}

/// Optional JSON sidecar. No cue is used until recording and lyric identity match.
public struct Choreography: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case verse, chorus, build, instrumental, finale }
  public enum Effect: String, Codable, Sendable { case emphasis, hold, arrival }
  public enum Provenance: String, Codable, Sendable { case automatic, reviewed }
  public struct Section: Codable, Equatable, Sendable {
    public var start: Double
    public var end: Double
    public var kind: Kind
    public var provenance: Provenance
  }
  public struct Cue: Codable, Equatable, Sendable {
    public var line: Int
    public var word: Int?
    public var effect: Effect
    public var provenance: Provenance
  }
  public var version: Int
  public var recording: RecordingIdentity
  public var lyricRevision: String
  public var sections: [Section]
  public var cues: [Cue]

  public func validated(recording target: RecordingIdentity?, timeline: Timeline) -> Choreography? {
    guard version == 1, recording.matches(target), lyricRevision == timeline.lyricRevision else { return nil }
    var result = self
    result.sections = sections.filter { $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end > $0.start && $0.end <= timeline.duration }
    result.cues = cues.filter { cue in
      guard timeline.lines.indices.contains(cue.line) else { return false }
      if let word = cue.word { return timeline.lines[cue.line].words.indices.contains(word) }
      return cue.effect == .arrival
    }
    return result
  }
}

/// Source clock and corrected audible position are separate from advance singer cues.
/// A future phone listener updates the timeline/revision and offset, never visual state.
public struct StageSample: Equatable, Sendable {
  public var playback: Double
  public var audible: Double
  public var cue: Double
  public var playing: Bool
  public var timingRevision: Int
  public var seekRevision: Int
  public init(playback: Double, audible: Double, cue: Double, playing: Bool, timingRevision: Int, seekRevision: Int = 0) {
    self.playback = playback; self.audible = audible; self.cue = cue
    self.playing = playing; self.timingRevision = timingRevision; self.seekRevision = seekRevision
  }
}

public struct StagePresentation: Equatable, Sendable {
  public init() {}
  public var line: Int = 0
  public var next: Int? = nil
  public var kind: Choreography.Kind = .verse
  public var previousKind: Choreography.Kind = .verse
  public var sectionTransition: Double = 1
  public var dense = false
  public var entrance: Double = 1
  public var emphasis: Int? = nil
  public var impact: Double = 0
  public var hold: Int? = nil
  public var countdown: Double? = nil
  public var ending = false
  public var build: Double = 0
  public var motionTime: Double = 0
  public var arrival: Double = 0
}

/// Value-type state machine: deterministic, replayable, independent of SwiftUI.
/// Events use stable lyric addresses; a timing revision cannot fire them twice.
public struct PhraseDirector: Sendable {
  private var previous: StageSample?
  private var consumed = Set<String>()
  private var entryAt: Double = 0
  private var arrivalAt: Double = -100
  private var emphasisAt: Double = -100
  private var emphasisWord: Int?
  private var activeLine = -1
  private var sectionKind: Choreography.Kind = .verse
  private var previousKind: Choreography.Kind = .verse
  private var sectionAt: Double = -100
  private var motionTime: Double = 0
  public init() {}

  public mutating func advance(timeline: Timeline, sections: [Sections.Section], choreography: Choreography?, sample: StageSample, preview: Double = 1.5) -> StagePresentation {
    guard !timeline.lines.isEmpty, sample.playback.isFinite, sample.audible.isFinite, sample.cue.isFinite else { return StagePresentation() }
    let delta = sample.playback - (previous?.playback ?? sample.playback)
    let discontinuity = previous == nil || previous?.seekRevision != sample.seekRevision || delta < -0.1 || delta > 0.8
    if discontinuity { consumed.removeAll(); emphasisWord = nil; arrivalAt = -100 }
    if sample.playing && !discontinuity { motionTime += max(0, delta) }
    let lines = timeline.lines
    var index = lines.lastIndex(where: { $0.start <= sample.cue }) ?? 0
    // Move to the next phrase early only after the previous phrase has finished.
    if index + 1 < lines.count, sample.cue >= lines[index].end { index += 1 }
    if !discontinuity { index = max(activeLine, index) }
    index = min(lines.count - 1, max(0, index))
    let line = lines[index]
    let changed = index != activeLine
    if changed || discontinuity {
      activeLine = index
      entryAt = motionTime
      emphasisWord = nil
    }
    let timeUntil = line.start - sample.cue
    var out = StagePresentation()
    out.line = index
    out.next = index + 1 < lines.count ? index + 1 : nil
    out.dense = StageDirection.isDense(line)
    out.ending = index == lines.count - 1 && sample.audible >= line.end
    out.countdown = timeUntil > 0 ? timeUntil : nil
    out.motionTime = motionTime
    // Never hide words at their onset, on seek, or when paused.
    out.entrance = discontinuity || !sample.playing || timeUntil <= 0 ? 1 : min(1, max(0, (motionTime - entryAt) / 0.24))
    if let section = sections.first(where: { sample.audible >= $0.start && sample.audible < $0.end }) {
      out.kind = section.part == .chorus ? .chorus : section.part.isInstrumental ? .instrumental : .verse
    }
    if let section = choreography?.sections.filter({ sample.audible >= $0.start && sample.audible < $0.end })
      .sorted(by: { $0.provenance == .reviewed && $1.provenance != .reviewed }).first {
      out.kind = section.kind
      if section.kind == .build { out.build = min(1, max(0, (sample.audible - section.start) / (section.end - section.start))) }
    }
    if let countdown = out.countdown, countdown > preview { out.kind = .instrumental }
    if discontinuity {
      sectionKind = out.kind; previousKind = out.kind; sectionAt = -100
    } else if out.kind != sectionKind {
      previousKind = sectionKind; sectionKind = out.kind; sectionAt = motionTime
    }
    out.previousKind = previousKind
    out.sectionTransition = min(1, max(0, (motionTime - sectionAt) / 0.7))
    for (wi, word) in line.words.enumerated() {
      let cue = choreography?.cues.first { $0.line == index && $0.word == wi && $0.provenance == .reviewed }
      let reliable = timeline.quality(line: index, word: wi) == .reliable
      if sample.audible >= word.start && sample.audible < word.end && ((reliable && word.end - word.start >= 1.8) || cue?.effect == .hold) {
        out.hold = wi
      }
      let id = "\(index):\(wi)"
      if sample.audible >= word.start, !consumed.contains(id) {
        consumed.insert(id)
        if cue?.effect == .emphasis && !discontinuity && sample.playing && sample.audible - word.start < 0.3 {
          emphasisAt = motionTime; emphasisWord = wi
        }
      }
    }
    let arrivalID = "arrival:\(index)"
    if sample.audible >= line.start, !consumed.contains(arrivalID) {
      consumed.insert(arrivalID)
      if choreography?.cues.contains(where: { $0.line == index && $0.effect == .arrival && $0.provenance == .reviewed }) == true,
        !discontinuity, sample.playing, sample.audible - line.start < 0.3 {
        arrivalAt = motionTime
      }
    }
    out.arrival = max(0, 1 - (motionTime - arrivalAt) / 0.8)
    let age = motionTime - emphasisAt
    if let word = emphasisWord, age >= 0, age < 0.55, !out.dense {
      out.emphasis = word; out.impact = pow(1 - age / 0.55, 2)
    }
    previous = sample
    return out
  }
}
