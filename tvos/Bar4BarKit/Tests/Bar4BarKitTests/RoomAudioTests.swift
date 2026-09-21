import XCTest
@testable import Bar4BarKit

private final class Wall: @unchecked Sendable {
  var t = 0.0
  var read: () -> Double { { [self] in t } }
}

final class RoomAudioTests: XCTestCase {
  // MARK: - the WAV header

  private func u32(_ d: Data, _ at: Int) -> UInt32 {
    d[at..<(at + 4)].reversed().reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
  }
  private func u16(_ d: Data, _ at: Int) -> UInt16 {
    d[at..<(at + 2)].reversed().reduce(UInt16(0)) { $0 << 8 | UInt16($1) }
  }
  private func ascii(_ d: Data, _ at: Int, _ n: Int) -> String {
    String(decoding: d[at..<(at + n)], as: UTF8.self)
  }

  func testWritesAWavHeaderAFingerprinterWillAccept() {
    let wav = RoomAudio.encodeWAV([0, 0, 0, 0], sampleRate: 44100)

    XCTAssertEqual(ascii(wav, 0, 4), "RIFF")
    XCTAssertEqual(ascii(wav, 8, 4), "WAVE")
    XCTAssertEqual(ascii(wav, 12, 4), "fmt ")
    XCTAssertEqual(u32(wav, 16), 16, "fmt chunk size")
    XCTAssertEqual(u16(wav, 20), 1, "PCM")
    XCTAssertEqual(u16(wav, 22), 1, "mono")
    XCTAssertEqual(u32(wav, 24), 44100)
    XCTAssertEqual(u32(wav, 28), 88200, "byte rate = rate × 2")
    XCTAssertEqual(u16(wav, 32), 2, "block align")
    XCTAssertEqual(u16(wav, 34), 16, "bits per sample")
    XCTAssertEqual(ascii(wav, 36, 4), "data")
    XCTAssertEqual(u32(wav, 40), 8, "data size = samples × 2")
    XCTAssertEqual(u32(wav, 4), UInt32(wav.count - 8), "RIFF size = file - 8")
  }

  func testLengthIsHeaderPlusTwoBytesPerSample() {
    XCTAssertEqual(RoomAudio.encodeWAV([Float](repeating: 0, count: 1000)).count, 44 + 2000)
    XCTAssertEqual(RoomAudio.encodeWAV([]).count, 44)
  }

  func testFullScaleSamplesHitTheIntegerLimits() {
    let wav = RoomAudio.encodeWAV([1.0, -1.0, 0.0])
    XCTAssertEqual(Int16(bitPattern: u16(wav, 44)), 32767)
    XCTAssertEqual(Int16(bitPattern: u16(wav, 46)), -32768)
    XCTAssertEqual(Int16(bitPattern: u16(wav, 48)), 0)
  }

  func testOutOfRangeSamplesClampInsteadOfWrapping() {
    // Without the clamp these overflow and a loud room turns into noise.
    let wav = RoomAudio.encodeWAV([9.0, -9.0])
    XCTAssertEqual(Int16(bitPattern: u16(wav, 44)), 32767)
    XCTAssertEqual(Int16(bitPattern: u16(wav, 46)), -32768)
  }

  func testRms() {
    XCTAssertEqual(RoomAudio.rms([0, 0, 0]), 0, accuracy: 0.0001)
    XCTAssertEqual(RoomAudio.rms([1, -1, 1, -1]), 1, accuracy: 0.0001)
    XCTAssertEqual(RoomAudio.rms([]), 0)
  }

  // MARK: - the rolling buffer

  private func tone(_ n: Int, amplitude: Float = 0.5) -> [Float] {
    (0..<n).map { amplitude * sinf(Float($0) * 0.1) }
  }

  func testStaysQuietUntilTheRoomGetsLoudEnough() {
    let buffer = RoomBuffer(seconds: 1, sampleRate: 100)
    buffer.append([Float](repeating: 0.001, count: 50)) // room tone
    XCTAssertNil(buffer.onsetAt)
    XCTAssertNil(buffer.chunk(), "silence must not spend an API call")
  }

  func testRecordsWhenTheMusicStarted() {
    let wall = Wall()
    let buffer = RoomBuffer(seconds: 1, sampleRate: 100, now: wall.read)

    wall.t = 500
    buffer.append([Float](repeating: 0.001, count: 10))
    XCTAssertNil(buffer.onsetAt)

    wall.t = 512
    buffer.append(tone(10))
    XCTAssertEqual(buffer.onsetAt, 512)

    wall.t = 600
    buffer.append(tone(10))
    XCTAssertEqual(buffer.onsetAt, 512, "onset is when it STARTED, not the last loud moment")
  }

  func testChunkCarriesTheOnsetAndRealAudio() {
    let wall = Wall()
    wall.t = 42
    let buffer = RoomBuffer(seconds: 1, sampleRate: 100, now: wall.read)
    buffer.append(tone(100))

    let chunk = buffer.chunk()
    XCTAssertEqual(chunk?.onsetAt, 42)
    XCTAssertEqual(chunk?.wav.count, 44 + 200)
  }

  func testAPartlyFilledBufferOnlyReturnsWhatItHeard() {
    let buffer = RoomBuffer(seconds: 1, sampleRate: 100)
    buffer.append(tone(30))
    XCTAssertEqual(buffer.ordered().count, 30)
  }

  func testTheRingWrapsAndStillReadsOldestFirst() {
    let buffer = RoomBuffer(seconds: 1, sampleRate: 10) // 10-sample ring
    buffer.append((1...10).map { Float($0) / 10 })
    buffer.append((11...13).map { Float($0) / 10 }) // wraps, evicting 0.1...0.3

    let out = buffer.ordered()
    XCTAssertEqual(out.count, 10)
    // Oldest surviving sample first, newest last — a scrambled order fingerprints
    // as noise and nothing ever matches.
    XCTAssertEqual(out.first!, 0.4, accuracy: 0.001)
    XCTAssertEqual(out.last!, 1.3, accuracy: 0.001)
    for i in 1..<out.count {
      XCTAssertGreaterThan(out[i], out[i - 1], "samples must stay in time order")
    }
  }

  func testResetForgetsTheSong() {
    let buffer = RoomBuffer(seconds: 1, sampleRate: 100)
    buffer.append(tone(100))
    XCTAssertNotNil(buffer.onsetAt)

    buffer.reset()
    XCTAssertNil(buffer.onsetAt)
    XCTAssertNil(buffer.chunk())
    XCTAssertTrue(buffer.ordered().isEmpty)
  }
}
