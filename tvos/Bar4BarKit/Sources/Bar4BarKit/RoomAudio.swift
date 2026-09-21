// The part of "listen to the room" that has no hardware in it: a rolling buffer
// of recent audio, when the music started, and the WAV bytes to send off.
//
// Ported from app/mic.js + app/wav.js. The format is not a free choice — it is
// what the web app already sends to ACRCloud and gets matches back from, so the
// tvOS side sends the same thing: mono, 44.1 kHz, 16-bit, about 12 seconds.
// A wrong WAV header does not error, it just silently never matches.

import Foundation

public enum RoomAudio {
  public static let sampleRate = 44100.0
  public static let bufferSeconds = 12.0
  /// RMS above which we call it "the music started". Matches app/mic.js.
  public static let onsetThreshold = 0.02

  /// Mono Float32 PCM → 16-bit PCM WAV bytes.
  public static func encodeWAV(_ samples: [Float], sampleRate: Double = sampleRate) -> Data {
    let dataSize = samples.count * 2
    var out = Data(capacity: 44 + dataSize)

    func ascii(_ s: String) { out.append(contentsOf: s.utf8) }
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) } }

    ascii("RIFF")
    u32(UInt32(36 + dataSize))
    ascii("WAVE")

    ascii("fmt ")
    u32(16) // fmt chunk size
    u16(1) // PCM
    u16(1) // mono
    u32(UInt32(sampleRate))
    u32(UInt32(sampleRate) * 2) // byte rate
    u16(2) // block align
    u16(16) // bits per sample

    ascii("data")
    u32(UInt32(dataSize))

    for sample in samples {
      let clamped = max(-1, min(1, sample))
      // -1 maps to Int16.min and +1 to Int16.max; the asymmetry is deliberate.
      let value = clamped < 0 ? Int16(clamped * 32768) : Int16(clamped * 32767)
      withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) }
    }
    return out
  }

  public static func rms(_ samples: [Float]) -> Double {
    guard !samples.isEmpty else { return 0 }
    var sum = 0.0
    for s in samples { sum += Double(s) * Double(s) }
    return (sum / Double(samples.count)).squareRoot()
  }
}

/// A fixed-size ring of the most recent audio, plus the moment the room first got
/// loud enough to be music. Feed it capture callbacks; ask it for a chunk.
public final class RoomBuffer {
  private var buffer: [Float]
  private let seconds: Double
  private var writeIndex = 0
  private var filled = false
  private let wallNow: () -> Double
  private let threshold: Double

  /// Wall time the room first crossed the noise floor, or nil while it is quiet.
  public private(set) var onsetAt: Double?
  /// Smoothed input level, 0...1 — for a listening indicator on screen.
  public private(set) var level = 0.0
  /// The rate the samples really arrive at, which is what the WAV must say.
  public private(set) var sampleRate: Double

  public init(
    seconds: Double = RoomAudio.bufferSeconds,
    sampleRate: Double = RoomAudio.sampleRate,
    threshold: Double = RoomAudio.onsetThreshold,
    now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.buffer = [Float](repeating: 0, count: Int(seconds * sampleRate))
    self.seconds = seconds
    self.sampleRate = sampleRate
    self.threshold = threshold
    self.wallNow = now
  }

  /// Capture on tvOS can't be asked for a format — `audioSettings` is
  /// unavailable there — so it vends whatever the device runs at, usually
  /// 48kHz. A 48kHz recording labelled 44.1kHz plays 9% slow, which is a
  /// fingerprint that matches nothing and an offset that drifts. Call this with
  /// the rate each capture buffer declares; it is free when nothing changed.
  public func adopt(sampleRate rate: Double) {
    guard rate.isFinite, rate > 0, rate != sampleRate else { return }
    sampleRate = rate
    buffer = [Float](repeating: 0, count: Int(seconds * rate))
    reset()
  }

  public func append(_ samples: [Float]) {
    let loudness = RoomAudio.rms(samples)
    level = level * 0.6 + loudness * 0.4
    if onsetAt == nil, loudness > threshold {
      onsetAt = wallNow()
    }
    for sample in samples {
      buffer[writeIndex] = sample
      writeIndex += 1
      if writeIndex >= buffer.count {
        writeIndex = 0
        filled = true
      }
    }
  }

  /// The last N seconds as WAV, or nil while the room has never been loud enough
  /// — there is no point spending an API call on silence.
  public func chunk() -> AudioChunk? {
    guard let onsetAt else { return nil }
    return AudioChunk(wav: RoomAudio.encodeWAV(ordered(), sampleRate: sampleRate), onsetAt: onsetAt)
  }

  /// Oldest sample first, which is what a fingerprint needs.
  public func ordered() -> [Float] {
    guard filled else { return Array(buffer[0..<writeIndex]) }
    return Array(buffer[writeIndex...]) + Array(buffer[0..<writeIndex])
  }

  public func reset() {
    onsetAt = nil
    filled = false
    writeIndex = 0
    level = 0
  }
}
