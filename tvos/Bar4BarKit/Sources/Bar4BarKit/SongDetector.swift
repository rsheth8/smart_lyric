// Listen to the room, work out what is playing and where it is up to.
//
// Port of `VinylDetector` in app/vinyl.js. Every few seconds it grabs a chunk of
// room audio, fingerprints it, and feeds the resulting position to a SyncClock.
// That is the whole reason the TV needs no playback control: it does not matter
// whether the sound came from Apple Music, Spotify, a turntable or a laptop
// across the room, because a microphone hears all of them the same way.
//
// Both edges are protocols so this file stays testable on a Mac: the real
// `AudioChunkSource` is the Continuity Mic (an iPhone acting as the Apple TV's
// microphone, which needs hardware) and the real `SongRecognizer` is ACRCloud's
// ambient-fingerprint API. Neither can run in a unit test; both are fakes there.

import Foundation

/// A few seconds of room audio, and the wall time its first real sound began.
public struct AudioChunk: Sendable {
  public var wav: Data
  /// Wall-clock seconds when audio first crossed the noise floor, or nil if the
  /// room was silent — used as a fallback position when the match carries none.
  public var onsetAt: Double?

  public init(wav: Data, onsetAt: Double?) {
    self.wav = wav
    self.onsetAt = onsetAt
  }
}

/// What a fingerprint match tells us.
public struct Recognition: Equatable, Sendable {
  public var recordingId: String
  public var title: String
  public var artist: String
  public var album: String?
  public var durationSec: Double?
  /// How far into the song the captured audio was. The whole point — this is what
  /// removes the count-in ritual and the manual nudging.
  public var offsetSec: Double?
  /// Match confidence, 0...1 when the service reports one.
  public var score: Double?

  public init(
    recordingId: String,
    title: String,
    artist: String,
    album: String? = nil,
    durationSec: Double? = nil,
    offsetSec: Double? = nil,
    score: Double? = nil
  ) {
    self.recordingId = recordingId
    self.title = title
    self.artist = artist
    self.album = album
    self.durationSec = durationSec
    self.offsetSec = offsetSec
    self.score = score
  }

  public var song: Song {
    Song(track: title, artist: artist, duration: durationSec)
  }
}

public protocol AudioChunkSource: Sendable {
  func captureChunk() async -> AudioChunk?
}

public protocol SongRecognizer: Sendable {
  /// nil means "heard it, matched nothing" — a miss, not an error.
  func identify(_ wav: Data) async throws -> Recognition?
}

public enum ListenState: String, Sendable {
  case idle, listening, locked
}

/// Why a poll did what it did — for the on-screen listening indicator.
public struct PollOutcome: Sendable {
  public enum Reason: String, Sendable {
    case noAudio, noMatch, lowScore, match
  }
  public var reason: Reason
  public var attempts: Int
  public var title: String?
  public var artist: String?
  public var score: Double?
}

@MainActor
public final class SongDetector {
  public private(set) var state = ListenState.idle
  public private(set) var attempts = 0

  private let source: AudioChunkSource
  private let recognizer: SongRecognizer
  private let clock: SyncClock
  private let wallNow: () -> Double
  private let searchInterval: Duration
  private let lockedInterval: Duration
  /// Longest we'll ever go without listening, when a match carried no duration.
  private let idleCeiling: Duration
  private let missTolerance: Int
  private let minScore: Double
  /// Song-time the current match says the track ends, so we can look again right
  /// as it does instead of waiting out a long idle interval.
  private var expectedEnd: Double?

  private var onSong: (Recognition) async -> Void
  private var onState: (ListenState) -> Void
  private var onPoll: (PollOutcome) -> Void

  private var currentId: String?
  private var misses = 0
  private var lastObservation: (song: Double, wall: Double)?
  private var task: Task<Void, Never>?

  public init(
    source: AudioChunkSource,
    recognizer: SongRecognizer,
    clock: SyncClock,
    now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
    searchInterval: Duration = .seconds(5),
    lockedInterval: Duration = .seconds(60),
    idleCeiling: Duration = .seconds(300),
    missTolerance: Int = 4,
    minScore: Double = 0.5,
    onSong: @escaping (Recognition) async -> Void = { _ in },
    onState: @escaping (ListenState) -> Void = { _ in },
    onPoll: @escaping (PollOutcome) -> Void = { _ in }
  ) {
    self.source = source
    self.recognizer = recognizer
    self.clock = clock
    self.wallNow = now
    self.searchInterval = searchInterval
    self.lockedInterval = lockedInterval
    self.idleCeiling = idleCeiling
    self.missTolerance = missTolerance
    self.minScore = minScore
    self.onSong = onSong
    self.onState = onState
    self.onPoll = onPoll
  }

  public func start() {
    guard task == nil else { return }
    set(state: .listening)
    task = Task { [weak self] in
      while !Task.isCancelled {
        await self?.pollOnce()
        guard let delay = self?.nextDelay() else { return }
        try? await Task.sleep(for: delay)
      }
    }
  }

  /// How long to wait before listening again.
  ///
  /// Every poll is a paid recognition request, so the only ones worth making are
  /// the ones that can tell us something we don't already know. Once locked there
  /// are only two such things:
  ///
  ///   • the song changed — and the cheapest place to look is right as the
  ///     current one is due to end, where that single poll doubles as the next
  ///     song's identification. One request per song, not one every few seconds.
  ///   • the source runs off-speed and the playhead is drifting. Anything digital
  ///     plays at exactly 1.0 and never drifts, so this only applies to a
  ///     turntable — and we can tell which we're on, because `observe` folds any
  ///     error into the rate. A rate that has moved off 1.0 buys mid-song checks;
  ///     one that hasn't does not need them.
  ///
  /// Fast again the moment a poll misses: that is how a song ending early, or the
  /// music simply stopping, gets noticed without polling constantly meanwhile.
  func nextDelay() -> Duration {
    guard state == .locked, misses == 0 else { return searchInterval }

    let driftsAudibly = abs(clock.rate - 1.0) > Self.rateTolerance
    var delay = Double((driftsAudibly ? lockedInterval : idleCeiling).components.seconds)

    if let expectedEnd {
      let remaining = expectedEnd - clock.now()
      if remaining > 0 { delay = min(delay, remaining + 1) }
    }
    return .seconds(max(2, Int(delay.rounded())))
  }

  /// Below this, a source is running at 1.0 for all practical purposes: 0.5% is
  /// under a second of drift across a whole song.
  static let rateTolerance = 0.005

  public func stop() {
    task?.cancel()
    task = nil
    currentId = nil
    misses = 0
    lastObservation = nil
    expectedEnd = nil
    set(state: .idle)
  }

  /// One listen → fingerprint → clock update. Returns the match, if there was one.
  @discardableResult
  public func pollOnce() async -> Recognition? {
    guard let chunk = await source.captureChunk(), chunk.onsetAt != nil else {
      emit(.noAudio)
      return nil
    }

    attempts += 1
    let result = try? await recognizer.identify(chunk.wav)

    guard let result else {
      emit(.noMatch)
      handleMiss()
      return nil
    }
    if let score = result.score, score < minScore {
      emit(.lowScore, result)
      handleMiss()
      return nil
    }

    let position = self.position(chunk: chunk, result: result)
    let wall = wallNow()

    expectedEnd = result.durationSec
    if result.recordingId != currentId {
      currentId = result.recordingId
      misses = 0
      lastObservation = (song: position, wall: wall)
      await onSong(result)
      clock.observe(position)
      set(state: .locked)
    } else {
      misses = 0
      if let last = lastObservation {
        clock.calibrateRate(song1: last.song, wall1: last.wall, song2: position, wall2: wall)
      }
      lastObservation = (song: position, wall: wall)
      clock.observe(position)
    }
    emit(.match, result)
    return result
  }

  /// The match's own offset when the service gives one; otherwise assume the song
  /// started when we first heard sound.
  private func position(chunk: AudioChunk, result: Recognition) -> Double {
    if let offset = result.offsetSec, offset.isFinite {
      return max(0, offset)
    }
    return max(0, wallNow() - (chunk.onsetAt ?? wallNow()))
  }

  /// A few misses in a row means the song ended or the room went quiet. Freeze the
  /// clock and go back to listening rather than letting it run away on its own.
  private func handleMiss() {
    guard state == .locked else { return }
    misses += 1
    guard misses >= missTolerance else { return }
    currentId = nil
    misses = 0
    lastObservation = nil
    expectedEnd = nil
    clock.pause()
    set(state: .listening)
  }

  private func set(state newState: ListenState) {
    guard newState != state else { return }
    state = newState
    onState(newState)
  }

  private func emit(_ reason: PollOutcome.Reason, _ result: Recognition? = nil) {
    onPoll(
      PollOutcome(
        reason: reason,
        attempts: attempts,
        title: result?.title,
        artist: result?.artist,
        score: result?.score
      )
    )
  }
}
