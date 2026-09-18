import SwiftUI
import Bar4BarCore

/// Glass field background + VU meters. No blur filters; no installation initials.
struct ListeningGlass: View {
  let state: StagePresentation
  let intensity: StageIntensity
  let partyMode: String
  let sideA: Bool
  let cheer: Double
  let playing: Bool
  let reduceMotion: Bool
  let artworkURL: URL?
  let lines: [LyricLine]
  let cueTime: Double
  let previewSeconds: Double
  let nowPlayingTitle: String
  let nowPlayingArtist: String

  @State private var dominant: (r: Double, g: Double, b: Double)? = nil
  @State private var smoother = GlassSmoother()

  var body: some View {
    GeometryReader { geo in
      let field = smoother.advance(computedField)
      let fieldRGB = GlassMath.field(dominant: dominant) ?? fieldFallbackRGB
      let fieldColor = Color(red: fieldRGB.r, green: fieldRGB.g, blue: fieldRGB.b)

      ZStack {
        // 1. Envelope — near-pure black, cool violet undertone
        let envBrightness = 0.5 + 0.5 * field.envelope
        Color(red: 0x03 / 255.0 * envBrightness,
              green: 0x01 / 255.0 * envBrightness,
              blue:  0x08 / 255.0 * envBrightness)

        // 2. Field ambient — hot radial bloom driven by artwork color; concert-bright
        RadialGradient(
          colors: [fieldColor.opacity(0.82 * field.iris + 0.50 * field.cheer), .clear],
          center: .center,
          startRadius: 0,
          endRadius: max(geo.size.width, geo.size.height) * 1.05
        )

        // 3. Stage-light cone from top — a violet wash like a follow spot
        LinearGradient(
          colors: [Tokens.Glass.spotlight.opacity(0.10 + 0.08 * field.iris), .clear],
          startPoint: .top,
          endPoint: UnitPoint(x: 0.5, y: 0.42)
        )

        // 4. Edge vignette — strong, frames center like a darkened venue
        RadialGradient(
          colors: [.clear, .black.opacity(0.72)],
          center: .center,
          startRadius: min(geo.size.width, geo.size.height) * 0.28,
          endRadius: max(geo.size.width, geo.size.height) * 0.82
        )

        // 5. Sleeve + entrance plate
        entrancePlateView(field: field)
        sleeveView(field: field)

        // 6. VU meters — thin neon slivers with glow bloom
        Canvas { ctx, size in
          let f = field
          // Thin sliver: 0.6% of width (~11 px on 1920)
          let meterW: CGFloat = size.width * 0.006
          let meterX: CGFloat = size.width * 0.022

          func drawMeter(x: CGFloat, h: CGFloat, peakH: CGFloat) {
            guard h > 1 else { return }
            let rect = CGRect(x: x, y: size.height - h, width: meterW, height: h)
            // Bloom layer — wider, low alpha
            ctx.fill(Path(roundedRect: rect.insetBy(dx: -meterW * 1.5, dy: 0), cornerRadius: 4),
                     with: .color(Tokens.Glass.meter.opacity(0.18)))
            // Core sliver — bright neon
            ctx.fill(Path(roundedRect: rect, cornerRadius: meterW / 2),
                     with: .color(Tokens.Glass.meter.opacity(0.80)))
            // Peak hold tick
            if peakH > 6 {
              let tickY = size.height - peakH - 3
              let tick = CGRect(x: x - meterW * 0.5, y: tickY, width: meterW * 2, height: 2)
              ctx.fill(Path(roundedRect: tick, cornerRadius: 1),
                       with: .color(Tokens.Glass.holdHorizon))
            }
          }

          drawMeter(x: meterX, h: size.height * f.leftMeter, peakH: size.height * smoother.peakL)
          drawMeter(x: size.width - meterX - meterW,
                    h: size.height * f.rightMeter, peakH: size.height * smoother.peakR)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
    }
    .task(id: artworkURL) {
      guard let url = artworkURL else { dominant = nil; return }
      if let rgb = await ArtworkAccent.dominantColor(of: url) {
        dominant = (r: rgb.r, g: rgb.g, b: rgb.b)
      } else {
        dominant = nil
      }
    }
  }

  // MARK: - Sleeve layer

  /// Instrumental artwork behind the field. Opacity 0.22…0.55 via sleeve.
  /// Drift suppressed under Reduce Motion by counteracting PictureArtwork's 1.08 scale.
  @ViewBuilder private func sleeveView(field: GlassField) -> some View {
    if field.sleeve > 0.05 {
      PictureArtwork(url: artworkURL, tint: Tokens.Glass.fieldFallback, amount: 1.0)
        // PictureArtwork body: opacity = 0.22 * amount = 0.22
        // We want total opacity = 0.22 + 0.33 * sleeve (0.22…0.55).
        // SwiftUI multiplies: 0.22 * (1 + 1.5 * sleeve) → correct.
        .opacity(1 + 1.5 * field.sleeve)
        // PictureArtwork does scaleEffect(1.08) for slow drift.
        // Reduce Motion: cancel that scale so the image sits still.
        .scaleEffect(reduceMotion ? 1.0 / 1.08 : 1.0)
    }
  }

  // MARK: - Entrance plate

  /// Long-intro card — only when vocals are > 1.2 s away (StageDirection contract).
  /// Behind the field so the first sung line is never covered.
  @ViewBuilder private func entrancePlateView(field: GlassField) -> some View {
    let firstStart = lines.first?.start
    if StageDirection.entranceIsFullCard(firstLineStart: firstStart, t: cueTime) {
      EntrancePlate(
        title: nowPlayingTitle,
        artist: nowPlayingArtist,
        artworkURL: artworkURL,
        tint: Tokens.Glass.fieldFallback,
        fullCard: true,
        opacity: 0.45
      )
    }
  }

  // MARK: - Derived field (stateless — GlassMath has no side effects)

  private var computedField: GlassField {
    GlassMath.field(
      state: state,
      intensity: intensity,
      partyMode: partyMode,
      sideA: sideA,
      cheer: cheer,
      playing: playing,
      reduceMotion: reduceMotion,
      nextVocalIn: nextVocalIn,
      inLongGap: inLongGap,
      wordKick: wordKick,
      previewSeconds: previewSeconds
    )
  }

  // MARK: - Derived properties

  private var activeLi: Int {
    DisplayMath.resolveActiveLine(lines, t: cueTime)
  }

  private var inLongGap: Bool {
    StageLookMath.inLongGap(lines: lines, t: cueTime, activeLi: activeLi)
  }

  /// Seconds until the next vocal line, derived the same way StageLookMath does it.
  private var nextVocalIn: Double? {
    DisplayMath.gapState(lines: lines, t: cueTime, activeLi: activeLi).nextVocalIn
  }

  private var wordKick: Double {
    StageDirection.wordImpact(lines: lines, t: cueTime, activeLi: activeLi)
  }

  // MARK: - Helpers

  private var fieldFallbackRGB: (r: Double, g: Double, b: Double) {
    // Deep concert violet — the default stage color when no artwork is present
    (r: 0x4A / 255.0, g: 0x10 / 255.0, b: 0x8A / 255.0)
  }
}

// MARK: - Field value smoother

/// Exponential smoothing for all GlassField values so iris, meters, etc.
/// animate fluidly at 60 fps rather than snapping between raw targets.
/// Call advance(_:) once per frame inside body — same pattern as PhraseRuntime.
private final class GlassSmoother {
  private var s = GlassField(
    iris: 0, warmth: 0.5, envelope: 0.5,
    leftMeter: 0.1, rightMeter: 0.1,
    sleeve: 0, breath: 0, cheer: 0, hold: 0
  )
  private(set) var peakL: Double = 0
  private(set) var peakR: Double = 0

  func advance(_ raw: GlassField) -> GlassField {
    let k = 0.14  // ~120 ms tau at 60 fps
    s.iris     = s.iris     + (raw.iris     - s.iris)     * k
    s.warmth   = s.warmth   + (raw.warmth   - s.warmth)   * k
    s.envelope = s.envelope + (raw.envelope - s.envelope) * k
    s.sleeve   = s.sleeve   + (raw.sleeve   - s.sleeve)   * k
    s.cheer    = s.cheer    + (raw.cheer    - s.cheer)    * k
    s.hold     = s.hold     + (raw.hold     - s.hold)     * k
    // Breath needs faster response — it fires within a 0.40 s window
    s.breath   = s.breath   + (raw.breath   - s.breath)   * 0.28
    // Meters: fast attack, slow decay — like a real VU meter
    let kL = raw.leftMeter  > s.leftMeter  ? 0.25 : 0.07
    let kR = raw.rightMeter > s.rightMeter ? 0.25 : 0.07
    s.leftMeter  = s.leftMeter  + (raw.leftMeter  - s.leftMeter)  * kL
    s.rightMeter = s.rightMeter + (raw.rightMeter - s.rightMeter) * kR
    // Peak hold: latch on rise, decay very slowly (~1 s half-life at 60 fps)
    peakL = max(s.leftMeter,  peakL  * 0.987)
    peakR = max(s.rightMeter, peakR  * 0.987)
    return s
  }
}
