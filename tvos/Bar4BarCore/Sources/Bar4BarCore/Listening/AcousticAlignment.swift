import Foundation
import Accelerate

public struct CTCWordTokens: Sendable {
  public var address: LyricAddress
  public var tokens: [Int]
  public init(address: LyricAddress, tokens: [Int]) { self.address = address; self.tokens = tokens }
}

/// Bounded prefix trellis. Leading/trailing unmatched sound has its own state and never becomes a word.
public enum CTCPrefixAligner {
  public struct Result: Sendable {
    public var words: [ObservedWord]
    public var score: Double
    public var completed: Bool
  }
  public static func align(logProbabilities: [Float], frames: Int, labels: Int, blank: Int,
    words: [CTCWordTokens], captureStart: Double, frameSeconds: Double) -> Result? {
    let tokens = words.flatMap(\.tokens)
    guard frames > 0, frames <= 1200, labels > 1, labels <= 4096, blank >= 0, blank < labels,
      logProbabilities.count == frames * labels, logProbabilities.allSatisfy(\.isFinite),
      !tokens.isEmpty, tokens.count <= 512, tokens.allSatisfy({ $0 >= 0 && $0 < labels && $0 != blank }),
      words.allSatisfy({ !$0.tokens.isEmpty }), captureStart.isFinite,
      frameSeconds.isFinite, frameSeconds > 0, frameSeconds <= 0.1 else { return nil }
    let states = tokens.count * 2 + 1
    var previous = [Float](repeating: -.infinity, count: states); previous[0] = 0
    var path = [UInt8](repeating: 0, count: frames * states)
    for frame in 0..<frames {
      var next = [Float](repeating: -.infinity, count: states)
      let row = frame * labels
      let unmatched = logProbabilities[row..<(row + labels)].max()! - 1.5
      for state in 0..<states {
        let token = state % 2 == 0 ? blank : tokens[state / 2]
        var best = previous[state]; var step: UInt8 = 0
        if state > 0, previous[state - 1] > best { best = previous[state - 1]; step = 1 }
        if state > 1, state % 2 == 1, tokens[state / 2] != tokens[state / 2 - 1], previous[state - 2] > best {
          best = previous[state - 2]; step = 2
        }
        let emission = state == 0 || state == states - 1
          ? max(logProbabilities[row + token], unmatched) : logProbabilities[row + token]
        next[state] = best + emission
        path[frame * states + state] = step
      }
      previous = next
    }
    // Compare prefixes per reached token so an incomplete upcoming phrase can still yield past words.
    let possible = (1..<states).filter { previous[$0].isFinite }
    guard let terminal = possible.max(by: { previous[$0] + Float($0 / 2) * 0.5 < previous[$1] + Float($1 / 2) * 0.5 }) else { return nil }
    var state = terminal
    var tokenFrames = [[Int]](repeating: [], count: tokens.count)
    for frame in stride(from: frames - 1, through: 0, by: -1) {
      if state % 2 == 1 { tokenFrames[state / 2].append(frame) }
      state -= Int(path[frame * states + state])
    }
    var cursor = 0; var output: [ObservedWord] = []
    for word in words {
      let indexes = cursor..<(cursor + word.tokens.count)
      guard indexes.allSatisfy({ !tokenFrames[$0].isEmpty }) else { break }
      let all = indexes.flatMap { tokenFrames[$0] }
      let confidences = indexes.flatMap { i in tokenFrames[i].map { exp(Double(logProbabilities[$0 * labels + tokens[i]])) } }
      let start = captureStart + Double(all.min()!) * frameSeconds
      let end = captureStart + Double(all.max()! + 1) * frameSeconds
      let score = confidences.reduce(0, +) / Double(confidences.count)
      output.append(ObservedWord(address: word.address, start: start, end: end, score: score,
        uncertainty: max(frameSeconds, (1 - score) * 0.2)))
      cursor += word.tokens.count
    }
    guard !output.isEmpty else { return nil }
    return Result(words: output, score: output.map(\.score).reduce(0,+) / Double(output.count), completed: output.count == words.count)
  }
}

public struct AcousticReference: Codable, Equatable, Sendable {
  public var version = 1
  public var recording: RecordingIdentity
  public var lyricRevision: String
  public var referenceVersion: String
  public var step: Double = 0.04
  public var bands: Int = 64
  public var features: [Float]
  public var reviewedWords: [LyricAddress]
  public init(recording: RecordingIdentity, lyricRevision: String, referenceVersion: String,
    features: [Float], reviewedWords: [LyricAddress] = []) {
    self.recording = recording; self.lyricRevision = lyricRevision; self.referenceVersion = referenceVersion
    self.features = features; self.reviewedWords = reviewedWords
  }
  public func valid(for context: ListeningContext) -> Bool {
    version == 1 && recording == context.recording && lyricRevision == context.lyricRevision
      && referenceVersion == context.referenceVersion && bands == 64 && step == 0.04
      && !features.isEmpty && features.count % bands == 0 && features.count <= 3_000_000
      && features.allSatisfy(\.isFinite)
  }
}

/// Cached spectrogram fingerprints, not beats inferred from word timestamps.
public enum AcousticFingerprint {
  public static let sampleRate = 16000
  public static let step = 0.04
  public static func features(_ samples: [Float]) -> [Float] {
    let count = 256, strideSamples = 640
    guard samples.count >= count, samples.count <= sampleRate * 6000,
      let setup = vDSP_create_fftsetup(8, FFTRadix(kFFTRadix2)) else { return [] }
    defer { vDSP_destroy_fftsetup(setup) }
    var window = [Float](repeating: 0, count: count)
    vDSP_hann_window(&window, vDSP_Length(count), Int32(vDSP_HANN_NORM))
    var result: [Float] = []
    for start in Swift.stride(from: 0, through: samples.count - count, by: strideSamples) {
      var real = [Float](repeating: 0, count: count / 2), imag = real
      let frame = zip(samples[start..<(start + count)], window).map(*)
      real.withUnsafeMutableBufferPointer { re in
        imag.withUnsafeMutableBufferPointer { im in
          var split = DSPSplitComplex(realp: re.baseAddress!, imagp: im.baseAddress!)
          frame.withUnsafeBufferPointer { values in
            values.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: count / 2) {
              vDSP_ctoz($0, 2, &split, 1, vDSP_Length(count / 2))
            }
          }
          vDSP_fft_zrip(setup, &split, 1, 8, FFTDirection(FFT_FORWARD))
        }
      }
      var bands = (1...64).map { i -> Float in log(1e-8 + real[i] * real[i] + imag[i] * imag[i]) }
      let mean = bands.reduce(0,+) / 64
      bands = bands.map { $0 - mean }
      let norm = sqrt(bands.map { $0 * $0 }.reduce(0,+))
      result.append(contentsOf: norm > 0.01 ? bands.map { $0 / norm } : [Float](repeating: 0, count: 64))
    }
    return result
  }
  public static func match(_ features: [Float], reference: AcousticReference,
    expectedStart: Double, duration: Double) -> (position: Double, score: Double)? {
    let frames = features.count / 64, total = reference.features.count / 64
    guard features.count % 64 == 0, frames >= 20, total >= frames, expectedStart.isFinite,
      duration.isFinite, reference.bands == 64, reference.step == step else { return nil }
    let lo = max(0, Int((expectedStart - 8) / step)), hi = min(total - frames, Int((expectedStart + 8) / step))
    guard lo <= hi else { return nil }
    var scores: [(Int, Double)] = []
    for offset in lo...hi {
      var values: [Double] = []
      for frame in Swift.stride(from: 0, to: frames, by: 2) {
        let a = frame * 64, b = (frame + offset) * 64
        let energy = features[a..<(a + 64)].map { $0 * $0 }.reduce(0,+)
        guard energy > 0.5 else { continue }
        var dot: Float = 0
        features.withUnsafeBufferPointer { x in reference.features.withUnsafeBufferPointer { y in
          vDSP_dotpr(x.baseAddress! + a, 1, y.baseAddress! + b, 1, &dot, 64)
        }}
        values.append(Double(dot))
      }
      if values.count >= 10 { scores.append((offset, ListeningMath.median(values))) }
    }
    guard let best = scores.max(by: { $0.1 < $1.1 }), best.1 >= 0.72 else { return nil }
    let other = scores.filter { abs($0.0 - best.0) > 12 }.map { $0.1 }.max() ?? -1
    guard best.1 - other >= 0.04 else { return nil }
    return (Double(best.0) * step + duration, best.1)
  }
}
