import Foundation

public struct LyricAddress: Codable, Hashable, Sendable {
  public var line: Int
  public var word: Int
  public init(line: Int, word: Int) { self.line = line; self.word = word }
}

public enum ListeningStatus: String, Codable, Sendable {
  case listening, checking, following, clearerSound, saved, stopped
  public var title: String {
    switch self {
    case .listening: return "Listening"
    case .checking: return "Checking timing"
    case .following: return "Following recording"
    case .clearerSound: return "Need clearer sound"
    case .saved: return "Using saved guidance"
    case .stopped: return "Not listening"
    }
  }
}

public struct ListeningContext: Codable, Equatable, Sendable {
  public var session: UUID
  public var play: UUID
  public var recording: RecordingIdentity
  public var cacheKey: String
  public var duration: Double
  public var lyricRevision: String
  public var seekEpoch: Int
  public var playing: Bool
  public var position: Double
  public var hostTime: Double
  public var language: String
  public var referenceVersion: String?
  public var instrumental: Bool
  public init(session: UUID, play: UUID, recording: RecordingIdentity, cacheKey: String,
    duration: Double, lyricRevision: String, seekEpoch: Int, playing: Bool,
    position: Double, hostTime: Double, language: String = "en", referenceVersion: String? = nil,
    instrumental: Bool = false) {
    self.session = session; self.play = play; self.recording = recording; self.cacheKey = cacheKey
    self.duration = duration; self.lyricRevision = lyricRevision; self.seekEpoch = seekEpoch
    self.playing = playing; self.position = position; self.hostTime = hostTime
    self.language = language; self.referenceVersion = referenceVersion; self.instrumental = instrumental
  }
  public var valid: Bool {
    recording.hasIdentifier && !cacheKey.isEmpty && !lyricRevision.isEmpty && seekEpoch >= 0
      && duration.isFinite && duration > 0 && duration < 86400
      && position.isFinite && position >= 0 && position <= duration + 1 && hostTime.isFinite
  }
  public func position(at host: Double) -> Double {
    min(duration, max(0, position + (playing ? host - hostTime : 0)))
  }
}

public struct ObservedWord: Codable, Equatable, Sendable {
  public var address: LyricAddress
  /// Capture-host coordinates, before output-delay conversion.
  public var start: Double
  public var end: Double
  public var score: Double
  public var uncertainty: Double
  public init(address: LyricAddress, start: Double, end: Double, score: Double, uncertainty: Double = 0) {
    self.address = address; self.start = start; self.end = end; self.score = score; self.uncertainty = uncertainty
  }
}

public struct AudioObservation: Codable, Sendable {
  public var session: UUID
  public var play: UUID
  public var seekEpoch: Int
  public var cacheKey: String
  public var lyricRevision: String
  public var captureStart: Double
  public var captureEnd: Double
  public var words: [ObservedWord]
  public var modelVersion: String
  public var cleanPass: Bool
  public var sourceValidated: Bool
  /// Independently fingerprinted source position at captureEnd; never derived from cursor predictions.
  public var referencePosition: Double?
  public var referenceVersion: String?
  public init(context: ListeningContext, captureStart: Double, captureEnd: Double,
    words: [ObservedWord], modelVersion: String, cleanPass: Bool = false,
    sourceValidated: Bool = false, referencePosition: Double? = nil) {
    session = context.session; play = context.play; seekEpoch = context.seekEpoch
    cacheKey = context.cacheKey; lyricRevision = context.lyricRevision
    self.captureStart = captureStart; self.captureEnd = captureEnd; self.words = words
    self.modelVersion = modelVersion; self.cleanPass = cleanPass; self.sourceValidated = sourceValidated
    self.referencePosition = referencePosition; referenceVersion = context.referenceVersion
  }
}

public struct LearnedWord: Codable, Equatable, Sendable {
  public var address: LyricAddress
  /// Source seconds for absolute evidence; seconds relative to phrase onset otherwise.
  public var start: Double
  public var end: Double
  public var absolute: Bool
  public var uncertainty: Double
  public var supportingPlays: Int
  public var modelVersion: String
}

public struct ListeningPacket: Codable, Sendable {
  public var context: ListeningContext
  public var timeline: Timeline
  public var reference: AcousticReference?
  public init(context: ListeningContext, timeline: Timeline, reference: AcousticReference? = nil) {
    self.context = context; self.timeline = timeline; self.reference = reference
  }
}

public enum ListeningMessage: Codable, Sendable {
  case hello, context(ListeningPacket), observation(AudioObservation), status(ListeningStatus)
  case ping(id: UUID, sent: Double)
  case pong(id: UUID, sent: Double, received: Double, replied: Double)
}

/// NTP-style four timestamps. Reject high-latency samples instead of assigning packet arrival to audio.
public struct HostClockMapping: Sendable {
  public private(set) var offset: Double = 0
  public private(set) var uncertainty: Double = .infinity
  private var samples: [(Double, Double)] = []
  public init() {}
  public mutating func observe(sent: Double, received: Double, replied: Double, arrived: Double) {
    guard [sent, received, replied, arrived].allSatisfy(\.isFinite), arrived >= sent, replied >= received else { return }
    let delay = arrived - sent - (replied - received)
    guard delay >= 0, delay < 0.25 else { return }
    samples.append((delay, ((received - sent) + (replied - arrived)) / 2))
    if samples.count > 24 { samples.removeFirst() }
    let best = samples.sorted { $0.0 < $1.0 }.prefix(4)
    offset = ListeningMath.median(best.map { $0.1 })
    uncertainty = max(best.map { $0.0 / 2 }.max() ?? .infinity,
      best.map { abs($0.1 - offset) }.max() ?? .infinity)
  }
  public func remoteTime(_ local: Double) -> Double { local + offset }
}

public enum ListeningMath {
  public static func median(_ values: [Double]) -> Double {
    let values = values.filter(\.isFinite).sorted()
    guard !values.isEmpty else { return 0 }
    let i = values.count / 2
    return values.count % 2 == 0 ? (values[i - 1] + values[i]) / 2 : values[i]
  }
}
