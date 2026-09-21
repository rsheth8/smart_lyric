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

  /// Smoothed room level, 0...1 — drives the listening indicator.
  var level: Double { buffer.level }
  var isRunning: Bool { running }

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
    guard let samples = Self.monoFloats(from: sampleBuffer), !samples.isEmpty else { return }
    Task { @MainActor [weak self] in self?.buffer.append(samples) }
  }

  /// Sample buffer → mono Float32. Capture hands us 16-bit interleaved by
  /// default, so convert and fold channels down rather than assuming a format.
  nonisolated static func monoFloats(from sampleBuffer: CMSampleBuffer) -> [Float]? {
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
    return mono
  }
}
