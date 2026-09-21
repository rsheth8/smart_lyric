// Scoring: did you sing the words, and were you on the note?
//
// A port of app/score.js, which already anticipated this exact situation. On
// the web the singer has their own microphone and the track is a separate audio
// node, so both signals are available: coverage (the timeline expected a voice
// and one arrived) and pitch (how close it sat to the melody).
//
// The TV has neither of those luxuries. It hears one room, through one mic, and
// it never owns the track's samples — that is the whole DRM wall SongDetector
// exists to route around. So there is no melody to compare against, and
// `pitch` is nil here, which the model already treats as a first-class case:
// the score falls back to coverage alone. See RoomVoice for the other half of
// the problem, which is that this room is also playing the music.
//
// Pure: no audio, no UI, so the whole model unit-tests.

import Foundation

public enum Score {
  /// Perfectly in tune out to here. A semitone is 100 cents.
  public static let toleranceCents = 50.0
  /// Beyond here it's a different note and scores nothing.
  public static let cutoffCents = 200.0
  /// Voice RMS above which we call it singing rather than room tone.
  public static let singLevel = 0.02
  /// Fewer expected frames than this and nobody really sang — no score card.
  public static let minFrames = 40
  /// Pitch's share of the score when we have a reference to compare against.
  public static let pitchWeight = 0.4

  static let grades: [(min: Int, name: String)] = [
    (90, "Superstar"),
    (80, "Headliner"),
    (70, "Encore"),
    (55, "Warmed up"),
    (0, "Keep going"),
  ]

  /// Every grade the card can print. The analytics allowlist in app/analytics.js
  /// mirrors this list exactly — the relay rejects a `song_scored` event whose
  /// grade isn't in it, so the two must not drift apart.
  public static let gradeNames = grades.map(\.name)

  public static func gradeFor(_ score: Int) -> String {
    for grade in grades where score >= grade.min { return grade.name }
    return grades[grades.count - 1].name
  }

  /// 1 when dead on, tapering to 0 a whole tone away.
  public static func pitchAccuracy(
    _ cents: Double?,
    tolerance: Double = toleranceCents,
    cutoff: Double = cutoffCents
  ) -> Double? {
    guard let cents, cents.isFinite else { return nil }
    let distance = abs(cents)
    if distance <= tolerance { return 1 }
    if distance >= cutoff { return 0 }
    return 1 - (distance - tolerance) / (cutoff - tolerance)
  }

  /// Blend the two signals. `pitch` is nil when there was no reference to hear,
  /// which on the TV is always.
  public static func combine(coverage: Double, pitch: Double?) -> Int {
    let covered = min(1, max(0, coverage))
    guard let pitch else { return Int((covered * 100).rounded()) }
    let tuned = min(1, max(0, pitch))
    return Int(((covered * (1 - pitchWeight) + tuned * pitchWeight) * 100).rounded())
  }
}

public struct ScoreResult: Equatable, Sendable {
  public var score: Int
  public var grade: String
  public var coverage: Double
  public var pitch: Double?
  public var bestStreak: Int
  public var frames: Int
  /// Whether pitch contributed at all, so the card can say what it measured
  /// rather than implying it judged intonation it never heard.
  public var scored: Bool

  public init(
    score: Int,
    grade: String,
    coverage: Double,
    pitch: Double? = nil,
    bestStreak: Int = 0,
    frames: Int = 0,
    scored: Bool = false
  ) {
    self.score = score
    self.grade = grade
    self.coverage = coverage
    self.pitch = pitch
    self.bestStreak = bestStreak
    self.frames = frames
    self.scored = scored
  }
}

public final class ScoreKeeper {
  private let singLevel: Double
  private let minFrames: Int

  private var expectedFrames = 0
  private var sungFrames = 0
  private var pitchFrames = 0
  private var pitchSum = 0.0
  private var streak = 0
  private var bestStreak = 0

  public init(singLevel: Double = Score.singLevel, minFrames: Int = Score.minFrames) {
    self.singLevel = singLevel
    self.minFrames = minFrames
  }

  @discardableResult
  public func reset() -> ScoreKeeper {
    expectedFrames = 0
    sungFrames = 0
    pitchFrames = 0
    pitchSum = 0
    streak = 0
    bestStreak = 0
    return self
  }

  /// One frame of evidence. `expected` = the timeline says a word is being sung
  /// right now; `level` = the singer's own RMS (see RoomVoice); `cents` =
  /// distance to the reference note, or nil when there is no reference.
  @discardableResult
  public func sample(expected: Bool, level: Double = 0, cents: Double? = nil) -> ScoreKeeper {
    guard expected else {
      // Instrumental breaks aren't scored — silence there is correct.
      streak = 0
      return self
    }
    expectedFrames += 1
    guard level >= singLevel else {
      streak = 0
      return self
    }
    sungFrames += 1
    streak += 1
    if streak > bestStreak { bestStreak = streak }
    if let accuracy = Score.pitchAccuracy(cents) {
      pitchFrames += 1
      pitchSum += accuracy
    }
    return self
  }

  /// Nil until there's enough evidence to be worth showing.
  public func result() -> ScoreResult? {
    guard expectedFrames >= minFrames else { return nil }
    let coverage = Double(sungFrames) / Double(expectedFrames)
    let pitch = pitchFrames > 0 ? pitchSum / Double(pitchFrames) : nil
    let score = Score.combine(coverage: coverage, pitch: pitch)
    return ScoreResult(
      score: score,
      grade: Score.gradeFor(score),
      coverage: coverage,
      pitch: pitch,
      bestStreak: bestStreak,
      frames: expectedFrames,
      scored: pitchFrames > 0
    )
  }
}

/// Pulling the singer back out of a room that is also playing the music.
///
/// The web scores a microphone that hears only the singer. The Apple TV has one
/// mic hearing both at once, so a plain level gate would happily award a
/// Superstar to an empty room with the stereo on.
///
/// Two uncorrelated sources add in power rather than amplitude, so the singer's
/// own RMS is sqrt(room² − music²). We can measure the music on its own because
/// the lyrics timeline says exactly when it expects no words — every gap
/// between lines is a fresh look at what the room sounds like with nobody
/// singing.
public final class RoomVoice {
  /// What the room sounds like with nobody singing: the music alone.
  public private(set) var baseline = 0.0
  private var seeded = false
  private let smoothing: Double

  public init(smoothing: Double = 0.1) {
    self.smoothing = smoothing
  }

  /// Feed every frame, singing or not. Returns the singer's own level.
  ///
  /// ponytail: the baseline only moves during gaps between lines, so a chorus
  /// that is genuinely louder than the verse before it reads as a little extra
  /// voice. Harmless at this resolution — we ask "is someone singing", not "how
  /// loud" — but a per-section baseline is the upgrade if scores skew high.
  public func voiceLevel(level: Double, expected: Bool) -> Double {
    guard level.isFinite, level > 0 else {
      if !expected { seedOrSmooth(0) }
      return 0
    }
    guard expected else {
      seedOrSmooth(level)
      return 0
    }
    // No music-only frame yet — the song opened straight onto a vocal. Trust the
    // raw level rather than scoring nothing at all.
    guard seeded else { return level }
    return (max(0, level * level - baseline * baseline)).squareRoot()
  }

  public func reset() {
    baseline = 0
    seeded = false
  }

  private func seedOrSmooth(_ level: Double) {
    baseline = seeded ? baseline + (level - baseline) * smoothing : level
    seeded = true
  }
}
