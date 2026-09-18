import Foundation

public struct AdaptiveListeningEngine: Sendable {
  public private(set) var alignment: Double = 0
  public private(set) var status: ListeningStatus = .checking
  public private(set) var profile: RecordingLearningProfile?
  public private(set) var context: ListeningContext?
  public var automatic = true
  public var protected = Set<LyricAddress>()
  private var baseline = Timeline(lines: [])
  private var lastWords: [LyricAddress: ObservedWord] = [:]
  private var targets: [Double] = []
  private var target: Double = 0
  private var pendingLarge: Double?
  private var lastEvidence: Double = -.infinity
  private var lastTick: Double?
  private var holdUntil: Double = -.infinity
  private var currentLine: Int = -1
  public init() {}

  public mutating func install(_ packet: ListeningPacket, saved: RecordingLearningProfile? = nil) {
    let discontinuity = context?.session != packet.context.session || context?.play != packet.context.play
      || context?.seekEpoch != packet.context.seekEpoch || context?.cacheKey != packet.context.cacheKey
      || context?.lyricRevision != packet.context.lyricRevision || context?.referenceVersion != packet.context.referenceVersion
    if discontinuity {
      lastWords.removeAll(); targets.removeAll(); protected.removeAll(); pendingLarge = nil
      alignment = 0; target = 0; lastTick = nil; lastEvidence = -.infinity; currentLine = -1
      profile = saved?.matches(packet.context) == true ? saved : RecordingLearningProfile(context: packet.context)
      status = profile?.accepted.isEmpty == false ? .saved : .checking
    }
    context = packet.context; baseline = packet.timeline
  }
  public mutating func manualAdjustment(at host: Double) { holdUntil = host + 20; targets.removeAll(); pendingLarge = nil }
  public mutating func resetLearning() { if let context { profile = RecordingLearningProfile(context: context) } }
  public mutating func restore(_ saved: RecordingLearningProfile) {
    if let context, saved.matches(context) { profile = saved; status = saved.accepted.isEmpty ? .checking : .saved }
  }

  /// Only independently source-validated or explicitly clean calibration observations are eligible.
  @discardableResult public mutating func observe(_ observation: AudioObservation, at host: Double) -> Bool {
    guard let context, context.valid, context.playing, observation.session == context.session,
      observation.play == context.play, observation.seekEpoch == context.seekEpoch,
      observation.cacheKey == context.cacheKey, observation.lyricRevision == context.lyricRevision,
      observation.referenceVersion == context.referenceVersion,
      observation.captureStart.isFinite, observation.captureEnd.isFinite,
      observation.captureEnd > observation.captureStart, observation.captureEnd - observation.captureStart <= 6.1,
      host - observation.captureEnd >= -0.1, host - observation.captureEnd <= 3,
      !observation.modelVersion.isEmpty, observation.words.count <= 512,
      observation.cleanPass || observation.sourceValidated,
      !context.instrumental || (observation.sourceValidated && observation.referencePosition != nil) else { return false }
    let absolute = observation.sourceValidated && context.referenceVersion != nil
      && observation.referencePosition?.isFinite == true
    if observation.sourceValidated && !absolute { return false }
    let valid = observation.words.filter { word in
      let a = word.address
      return baseline.lines.indices.contains(a.line) && baseline.lines[a.line].words.indices.contains(a.word)
        && [word.start, word.end, word.score, word.uncertainty].allSatisfy(\.isFinite)
        && word.score >= 0.7 && word.score <= 1 && word.uncertainty >= 0 && word.uncertainty <= 0.1
        && word.end > word.start && word.start >= observation.captureStart
        && word.end <= observation.captureEnd - 0.5
    }
    let stable = valid.filter { word in
      guard let old = lastWords[word.address] else { return false }
      return abs(old.start - word.start) <= 0.1 && abs(old.end - word.end) <= 0.15
    }
    // Use only the last bounded window for corroboration, not an unbounded accumulation of addresses.
    lastWords = Dictionary(valid.map { ($0.address, $0) }, uniquingKeysWith: { _, latest in latest })
    guard !stable.isEmpty || absolute else { status = .checking; return false }
    lastEvidence = host
    let phase: Double
    if absolute, let source = observation.referencePosition {
      guard source >= 0, source <= context.duration else { return false }
      phase = source - context.position(at: observation.captureEnd)
    } else {
      phase = ListeningMath.median(stable.map { baseline.lines[$0.address.line].words[$0.address.word].start - context.position(at: $0.start) })
    }
    guard phase.isFinite, abs(phase) <= 10 else { return false }
    targets.append(phase); if targets.count > 14 { targets.removeFirst() }
    let median = ListeningMath.median(targets)
    let mad = ListeningMath.median(targets.map { abs($0 - median) })
    let inliers = targets.filter { abs($0 - median) <= max(0.12, 2 * mad) }
    if inliers.count >= 2 {
      let next = ListeningMath.median(inliers)
      if abs(next - alignment) > 1 { pendingLarge = next } else { target = next }
    }
    // Source timelines remove measured route phase exactly once. Relative profiles need no route estimate.
    let grouped = Dictionary(grouping: stable, by: { $0.address.line })
    var learned: [LearnedWord] = []
    for (line, words) in grouped {
      guard absolute || words.contains(where: { $0.address.word == 0 }) else { continue }
      let origin = words.first(where: { $0.address.word == 0 })?.start ?? 0
      for word in words {
        let start = absolute ? context.position(at: word.start) + phase : word.start - origin
        let end = absolute ? context.position(at: word.end) + phase : word.end - origin
        guard start >= 0, end > start, absolute ? end <= context.duration : end <= baseline.lines[line].end - baseline.lines[line].start + 2 else { continue }
        learned.append(LearnedWord(address: word.address, start: start, end: end, absolute: absolute,
          uncertainty: word.uncertainty, supportingPlays: 1, modelVersion: observation.modelVersion))
      }
    }
    // Durable changes require a declared recording-only pass even if a mix fingerprint locks position.
    if observation.cleanPass { profile?.add(learned, play: observation.play) }
    status = inliers.count >= 2 ? .following : .checking
    return true
  }

  public mutating func tick(at host: Double, playback: Double, playing: Bool) -> Double {
    let dt = min(0.25, max(0, host - (lastTick ?? host))); lastTick = host
    guard automatic, playing, host >= holdUntil else { return alignment }
    let line = baseline.lines.lastIndex(where: { $0.start <= playback + alignment }) ?? -1
    let boundary = line != currentLine
    currentLine = line
    if host - lastEvidence > 5 {
      status = profile?.accepted.isEmpty == false ? .saved : .clearerSound
      pendingLarge = nil; target = alignment
      return alignment
    }
    if boundary, let pendingLarge { alignment = pendingLarge; target = pendingLarge; self.pendingLarge = nil }
    let error = target - alignment
    alignment += max(-0.08 * dt, min(0.08 * dt, error))
    return alignment
  }
  public func guidedTimeline(afterLine: Int = -1) -> Timeline {
    profile?.applying(to: baseline, protected: protected, afterLine: afterLine) ?? baseline
  }
}
