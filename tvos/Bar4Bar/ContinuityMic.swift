// The Apple TV's ears.
//
// An Apple TV has no microphone of its own. tvOS 17 added Continuity Camera and
// Mic, so a nearby iPhone or iPad becomes an ordinary AVCaptureDevice and shows
// up in an AVCaptureSession like any other input. Requires an Apple TV 4K (2nd
// gen) or later and iOS 17+ on the phone.
//
// Everything interesting — the ring buffer, onset detection, WAV encoding — is
// in Bar4BarKit.RoomBuffer, where it is unit-tested. This file is only the shim
// that turns capture callbacks into `[Float]`, because a capture session cannot
// run in a test.
//
// Note the deliberate lack of audio "cleanup": no noise suppression, no AGC. The
// same choice app/mic.js makes, for the same reason — that DSP is tuned to make
// speech intelligible and it corrupts a fingerprint.
//
// The same capture also feeds the voice monitor, the web app's signal chain:
//
//   capture ─┬─ RoomBuffer (always on — fingerprinting and scoring)
//            └─ VoiceOut: player → reverb → the TV's speakers (only when asked)

import AVFoundation
import Bar4BarKit

@MainActor
final class ContinuityMic: NSObject, AudioChunkSource {
  enum Availability {
    case ready
    case needsPermission
    case noDevice // no phone nearby, or an Apple TV too old for Continuity
  }

  private let session = AVCaptureSession()
  private let output = AVCaptureAudioDataOutput()
  private let queue = DispatchQueue(label: "app.bar4bar.mic")
  private let buffer = RoomBuffer()
  private var running = false
  /// Fed straight from the capture queue, so it never waits on the main actor.
  nonisolated let voice = VoiceOut()
  /// How much audio each capture callback carries — a hop of monitor latency.
  private var captureSeconds = 0.0

  /// Smoothed room level, 0...1 — drives the listening indicator.
  var level: Double { buffer.level }
  var isRunning: Bool { running }

  /// Play the mic back through the TV. Returns the round trip the system will
  /// admit to, or nil if there is no mic or the output wouldn't start.
  func startMonitor(reverb: Double) -> Double? {
    guard running, voice.start(sampleRate: buffer.sampleRate, reverb: reverb) else { return nil }
    return voice.latency + captureSeconds
  }

  static func permission() async -> Availability {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return .ready
    case .notDetermined:
      return await AVCaptureDevice.requestAccess(for: .audio) ? .ready : .needsPermission
    default: return .needsPermission
    }
  }

  /// Starts listening. Returns why it couldn't, if it couldn't.
  @discardableResult
  func start() async -> Availability {
    guard !running else { return .ready }

    let allowed = await Self.permission()
    guard allowed == .ready else { return allowed }
    guard
      let device = AVCaptureDevice.default(for: .audio),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else { return .noDevice }

    session.beginConfiguration()
    session.addInput(input)
    output.setSampleBufferDelegate(self, queue: queue)
    if session.canAddOutput(output) { session.addOutput(output) }
    session.commitConfiguration()

    buffer.reset()
    // startRunning blocks; keep it off the main actor so the UI doesn't hitch.
    let session = self.session
    await Task.detached { session.startRunning() }.value
    running = true
    return .ready
  }

  func stop() {
    guard running else { return }
    running = false
    voice.stop()
    let session = self.session
    Task.detached { session.stopRunning() }
    buffer.reset()
  }

  nonisolated func captureChunk() async -> AudioChunk? {
    await MainActor.run { buffer.chunk() }
  }
}

extension ContinuityMic: AVCaptureAudioDataOutputSampleBufferDelegate {
  nonisolated func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let (samples, rate) = Self.monoFloats(from: sampleBuffer), !samples.isEmpty else { return }
    voice.feed(samples, sampleRate: rate)
    Task { @MainActor [weak self] in
      guard let self else { return }
      buffer.adopt(sampleRate: rate)
      buffer.append(samples)
      captureSeconds = Double(samples.count) / rate
    }
  }

  /// Sample buffer → mono Float32 and the rate it was recorded at. Capture hands
  /// us 16-bit interleaved at the device's native rate by default (tvOS won't
  /// let us ask for anything else), so convert and fold channels down rather
  /// than assuming a format.
  nonisolated static func monoFloats(from sampleBuffer: CMSampleBuffer) -> ([Float], Double)? {
    guard
      let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      let block = CMSampleBufferGetDataBuffer(sampleBuffer)
    else { return nil }

    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                      totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
          let pointer else { return nil }

    let channels = Int(asbd.mChannelsPerFrame == 0 ? 1 : asbd.mChannelsPerFrame)
    let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0

    var mono: [Float] = []
    if isFloat {
      let count = length / MemoryLayout<Float>.size
      let raw = UnsafeRawPointer(pointer).bindMemory(to: Float.self, capacity: count)
      mono.reserveCapacity(count / channels)
      for frame in stride(from: 0, to: count, by: channels) {
        var sum: Float = 0
        for c in 0..<channels where frame + c < count { sum += raw[frame + c] }
        mono.append(sum / Float(channels))
      }
    } else {
      let count = length / MemoryLayout<Int16>.size
      let raw = UnsafeRawPointer(pointer).bindMemory(to: Int16.self, capacity: count)
      mono.reserveCapacity(count / channels)
      for frame in stride(from: 0, to: count, by: channels) {
        var sum: Float = 0
        for c in 0..<channels where frame + c < count { sum += Float(raw[frame + c]) / 32768 }
        mono.append(sum / Float(channels))
      }
    }
    return (mono, asbd.mSampleRate)
  }
}

/// The singer's voice, back out of the TV's speakers with a little reverb.
///
/// Fed from the capture callbacks rather than a second input on AVAudioEngine:
/// the Continuity Mic is known to arrive as an AVCaptureDevice, and opening one
/// mic from two APIs is asking for one of them to lose it.
///
/// ponytail: that costs a capture buffer of latency (~20ms) on top of what the
/// system reports, and the phone-to-TV hop costs more that nothing here can
/// measure. If the Continuity Mic turns out to be an AVAudioSession input too,
/// `AVAudioEngine.inputNode` with a tap for the fingerprint is the faster shape
/// — measure on a real Apple TV before rebuilding around it.
final class VoiceOut: @unchecked Sendable {
  /// Buffers allowed to wait for playback. The phone's clock and the TV's never
  /// quite agree, and an unbounded queue turns that drift into seconds of lag
  /// over a song. Past this we drop a buffer: a click beats an echo.
  static let maxQueued = 3

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let reverb = AVAudioUnitReverb()
  // `format` doubles as the on switch: nil means off. Both it and `queued` are
  // read on the capture queue and the audio thread, so they live behind a lock.
  private let lock = NSLock()
  private var format: AVAudioFormat?
  private var queued = 0

  init() {
    engine.attach(player)
    engine.attach(reverb)
    reverb.loadFactoryPreset(.mediumRoom)
  }

  var isRunning: Bool { engine.isRunning }

  /// The round trip the system admits to. A floor — see Monitor.verdict.
  var latency: Double {
    let session = AVAudioSession.sharedInstance()
    return session.inputLatency + session.outputLatency + session.ioBufferDuration
  }

  func start(sampleRate: Double, reverb amount: Double) -> Bool {
    guard !isRunning else { return true }
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else {
      return false
    }
    let session = AVAudioSession.sharedInstance()
    do {
      // Only if it isn't already: re-categorising under a running capture can
      // interrupt it. `.default` rather than `.voiceChat` on purpose — voice
      // chat's echo cancelling would hide the howl from FeedbackGuard and
      // scrub the music out of the fingerprint.
      if session.category != .playAndRecord {
        try session.setCategory(.playAndRecord, mode: .default)
      }
      try session.setActive(true)
      engine.connect(player, to: reverb, format: format)
      engine.connect(reverb, to: engine.mainMixerNode, format: format)
      setReverb(amount)
      try engine.start()
    } catch {
      return false
    }
    lock.withLock {
      self.format = format
      queued = 0
    }
    player.play()
    return true
  }

  func stop() {
    lock.withLock { format = nil }
    player.stop()
    engine.stop()
  }

  func setReverb(_ amount: Double) {
    reverb.wetDryMix = Monitor.wetDryMix(amount)
  }

  /// Capture queue. Anything that doesn't match the running format is dropped:
  /// scheduleBuffer raises an Objective-C exception on a mismatch, and Swift
  /// can't catch those.
  func feed(_ samples: [Float], sampleRate: Double) {
    let format: AVAudioFormat? = lock.withLock {
      guard let format = self.format, format.sampleRate == sampleRate,
            queued < Self.maxQueued else { return nil }
      queued += 1
      return format
    }
    guard let format else { return }
    guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
          let channel = pcm.floatChannelData?[0] else {
      lock.withLock { queued -= 1 }
      return
    }
    pcm.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
    player.scheduleBuffer(pcm) { [weak self] in
      guard let self else { return }
      lock.withLock { self.queued = max(0, self.queued - 1) }
    }
  }
}
