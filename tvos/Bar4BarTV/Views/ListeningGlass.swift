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
        // 1. Envelope background — warm black, brightness follows playing state
        let envBrightness = 0.5 + 0.5 * field.envelope
        Color(red: 0x0C / 255.0 * envBrightness,
              green: 0x0A / 255.0 * envBrightness,
              blue:  0x08 / 255.0 * envBrightness)

        // 2. Field ambient — larger, brighter radial glow; soft falloff past screen edge
        RadialGradient(
          colors: [fieldColor.opacity(0.55 * field.iris + 0.32 * field.cheer), .clear],
          center: .center,
          startRadius: 0,
          endRadius: max(geo.size.width, geo.size.height) * 0.78
        )

        // 3. Edge vignette — darkens corners, frames the center as a lit stage
        RadialGradient(
          colors: [.clear, .black.opacity(0.50)],
          center: .center,
          startRadius: min(geo.size.width, geo.size.height) * 0.32,
          endRadius: max(geo.size.width, geo.size.height) * 0.80
        )

        // 4. Sleeve + entrance plate
        entrancePlateView(field: field)
        sleeveView(field: field)

        // 5. VU meters with peak hold — Canvas is lightweight, no SwiftUI layout overhead
        Canvas { ctx, size in
          let f = field
          let meterW = size.width * 0.035
          let meterX = size.width * 0.025

          // Left bar
          let meterH_L = size.height * f.leftMeter
          if meterH_L > 1 {
            ctx.fill(Path(roundedRect: CGRect(x: meterX, y: size.height - meterH_L,
                                              width: meterW, height: meterH_L), cornerRadius: 3),
                     with: .color(Tokens.Glass.meter.opacity(0.55)))
          }
          // Left peak hold dot
          let peakH_L = size.height * smoother.peakL
          if peakH_L > 6 {
            ctx.fill(Path(roundedRect: CGRect(x: meterX, y: size.height - peakH_L - 4,
                                              width: meterW, height: 3), cornerRadius: 1.5),
                     with: .color(Tokens.Glass.meter.opacity(0.90)))
          }

          // Right bar
          let meterH_R = size.height * f.rightMeter
          if meterH_R > 1 {
            ctx.fill(Path(roundedRect: CGRect(x: size.width - meterX - meterW,
                                              y: size.height - meterH_R,
                                              width: meterW, height: meterH_R), cornerRadius: 3),
                     with: .color(Tokens.Glass.meter.opacity(0.55)))
          }
          // Right peak hold dot
          let peakH_R = size.height * smoother.peakR
          if peakH_R > 6 {
            ctx.fill(Path(roundedRect: CGRect(x: size.width - meterX - meterW,
                                              y: size.height - peakH_R - 4,
                                              width: meterW, height: 3), cornerRadius: 1.5),
                     with: .color(Tokens.Glass.meter.opacity(0.90)))
          }
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
    // Warm amber — bright enough to be perceptible even without artwork
    (r: 0xBE / 255.0, g: 0x72 / 255.0, b: 0x30 / 255.0)
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
