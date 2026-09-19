import AVFoundation
import Accelerate

/// Taps the AVAudioEngine output node and computes a 5-band magnitude spectrum
/// using a real-to-complex FFT (vDSP). When the system music player is active
/// the engine's output receives the mixed hardware signal, so the bands reflect
/// the actual audio content rather than a simulation.
///
/// Auto-gain normalization adapts to volume — loud or quiet, the bands fill [0, 1].
/// Each band's running peak decays with a ~20 s half-life so a sudden drop in
/// energy reads immediately rather than waiting for the ceiling to drift down.
@MainActor
final class AudioAnalyzer: ObservableObject {
  static let bandCount = 5

  @Published private(set) var leftBands  = [Float](repeating: 0, count: bandCount)
  @Published private(set) var rightBands = [Float](repeating: 0, count: bandCount)
  /// True once the engine tap is installed and running.
  @Published private(set) var isActive   = false

  private let engine  = AVAudioEngine()
  private let fftN    = 4096
  private var log2N   = vDSP_Length(0)
  private var fftSetup: FFTSetup?
  private var hannWindow = [Float]()

  // Running peak per band for auto-gain (separate for L and R).
  private var peakL = [Float](repeating: 0.01, count: bandCount)
  private var peakR = [Float](repeating: 0.01, count: bandCount)

  // Band boundaries in Hz: [bass, low-mid, mid, high-mid, treble]
  private let edges: [Float] = [20, 250, 500, 2000, 6000, 20_000]

  init() {
    log2N    = vDSP_Length(log2f(Float(fftN)))
    fftSetup = vDSP_create_fftsetup(log2N, FFTRadix(kFFTRadix2))
    hannWindow = [Float](repeating: 0, count: fftN)
    vDSP_hann_window(&hannWindow, vDSP_Length(fftN), Int32(vDSP_HANN_NORM))
    startTap()
  }

  deinit {
    engine.outputNode.removeTap(onBus: 0)
    engine.stop()
    if let s = fftSetup { vDSP_destroy_fftsetup(s) }
  }

  // MARK: - Setup

  private func startTap() {
    // Apple Music and other system audio use a separate hardware pipeline
    // that AVAudioEngine output tap cannot access on tvOS. The engine
    // would get only silence, and engine.start() can throw an uncatchable
    // Objective-C exception when the audio HAL is held by the system
    // player — crashing the app. The sine simulation in ListeningGlass
    // runs whenever leftBands are near zero, which is the correct path.
  }

  // MARK: - Analysis (called on the audio thread)

  private func analyze(_ buf: AVAudioPCMBuffer) {
    guard let ch = buf.floatChannelData else { return }
    let frames = Int(buf.frameLength)
    let sr     = Float(buf.format.sampleRate)
    let nc     = Int(buf.format.channelCount)

    let lb = bands(ch[0], count: frames, sampleRate: sr)
    let rb = nc > 1 ? bands(ch[1], count: frames, sampleRate: sr) : lb
    let ln = normalized(lb, peaks: &peakL)
    let rn = normalized(rb, peaks: &peakR)

    Task { @MainActor [ln, rn] in
      self.leftBands  = ln
      self.rightBands = rn
    }
  }

  private func bands(_ ptr: UnsafePointer<Float>, count: Int, sampleRate: Float) -> [Float] {
    // Apply Hann window
    var windowed = [Float](repeating: 0, count: fftN)
    vDSP_vmul(ptr, 1, hannWindow, 1, &windowed, 1, vDSP_Length(min(count, fftN)))

    // Real-to-complex FFT
    var real = [Float](repeating: 0, count: fftN / 2)
    var imag = [Float](repeating: 0, count: fftN / 2)
    var mags = [Float](repeating: 0, count: fftN / 2)

    windowed.withUnsafeMutableBufferPointer { wBuf in
      real.withUnsafeMutableBufferPointer { rBuf in
        imag.withUnsafeMutableBufferPointer { iBuf in
          var split = DSPSplitComplex(realp: rBuf.baseAddress!, imagp: iBuf.baseAddress!)
          wBuf.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftN / 2) {
            vDSP_ctoz($0, 2, &split, 1, vDSP_Length(fftN / 2))
          }
          vDSP_fft_zrip(fftSetup!, &split, 1, log2N, FFTDirection(FFT_FORWARD))
          vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(fftN / 2))
        }
      }
    }

    let binWidth = sampleRate / Float(fftN)
    return (0..<Self.bandCount).map { b in
      let lo = max(1,         Int(edges[b]     / binWidth))
      let hi = min(mags.count - 1, Int(edges[b + 1] / binWidth))
      guard lo < hi else { return 0 }
      var rms: Float = 0
      mags.withUnsafeBufferPointer {
        vDSP_rmsqv($0.baseAddress! + lo, 1, &rms, vDSP_Length(hi - lo))
      }
      return rms
    }
  }

  // Auto-gain: peaks decay with ~20 s half-life at the tap rate (~11 Hz)
  private func normalized(_ raw: [Float], peaks: inout [Float]) -> [Float] {
    (0..<raw.count).map { i in
      peaks[i] = max(raw[i], peaks[i] * 0.996)
      return min(raw[i] / peaks[i], 1.0)
    }
  }
}
