import SwiftUI
import Bar4BarCore

/// The room-scale layer behind the words. All movement is clock-derived, so
/// pausing freezes the composition and resuming never has to catch up.
struct CinematicStageFX: View {
  let look: StageLook
  let light: StageLight
  let accent: AccentPalette
  let t: Double
  let wordImpact: Double
  let chorusDrop: Double
  let finale: Bool
  let roomEnergy: Double
  let reduceMotion: Bool

  var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      ZStack {
        stageBeams(size: size)

        // A low horizon makes the words feel suspended over a venue instead
        // of printed on a flat panel.
        Ellipse()
          .fill(
            RadialGradient(
              colors: [
                accent.glow.opacity(0.18 + 0.12 * light.anthem + 0.16 * roomEnergy),
                accent.glow.opacity(0.045),
                .clear,
              ],
              center: .center,
              startRadius: 0,
              endRadius: max(520, size.width * 0.46)
            )
          )
          .frame(width: size.width * 1.12, height: size.height * 0.34)
          .position(x: size.width * 0.5, y: size.height * 0.94)

        // A word onset flashes the key light behind the active lyric. The
        // opacity stays low enough to preserve contrast on HDR televisions.
        Ellipse()
          .fill(accent.soft.opacity((0.025 + 0.07 * wordImpact) * (1 - light.breath)))
          .frame(width: size.width * (0.42 + 0.08 * wordImpact), height: size.height * 0.34)
          .position(x: size.width / 2, y: size.height * 0.52)

        if look == .anthem {
          anthemRays(size: size)
        }

        ChorusDropPlate(
          progress: chorusDrop,
          finale: finale,
          accent: accent,
          reduceMotion: reduceMotion
        )
      }
      .clipped()
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private func stageBeams(size: CGSize) -> some View {
    Canvas(opaque: false, colorMode: .linear, rendersAsynchronously: true) { context, canvas in
      // The gradients already feather the beams; a smaller asynchronous blur
      // keeps the light soft without monopolizing the 4K render pass.
      context.addFilter(.blur(radius: 14))
      let sway = reduceMotion ? 0 : sin(t * 0.16) * 70
      let strength = (0.055 + 0.08 * light.anthem + 0.06 * light.picture + 0.09 * roomEnergy)
        * (1 - 0.94 * light.breath)

      var left = Path()
      left.move(to: CGPoint(x: -40, y: -50))
      left.addLine(to: CGPoint(x: canvas.width * 0.16 + sway, y: -50))
      left.addLine(to: CGPoint(x: canvas.width * 0.52 + sway, y: canvas.height))
      left.addLine(to: CGPoint(x: canvas.width * 0.22 + sway, y: canvas.height))
      left.closeSubpath()
      context.fill(
        left,
        with: .linearGradient(
          Gradient(colors: [accent.soft.opacity(strength), accent.glow.opacity(0)]),
          startPoint: CGPoint(x: canvas.width * 0.08, y: 0),
          endPoint: CGPoint(x: canvas.width * 0.42, y: canvas.height)
        )
      )

      var right = Path()
      right.move(to: CGPoint(x: canvas.width * 0.82 - sway, y: -50))
      right.addLine(to: CGPoint(x: canvas.width + 40, y: -50))
      right.addLine(to: CGPoint(x: canvas.width * 0.78 - sway, y: canvas.height))
      right.addLine(to: CGPoint(x: canvas.width * 0.50 - sway, y: canvas.height))
      right.closeSubpath()
      context.fill(
        right,
        with: .linearGradient(
          Gradient(colors: [accent.accent.opacity(strength * 0.82), accent.glow.opacity(0)]),
          startPoint: CGPoint(x: canvas.width * 0.92, y: 0),
          endPoint: CGPoint(x: canvas.width * 0.62, y: canvas.height)
        )
      )
    }
  }

  private func anthemRays(size: CGSize) -> some View {
    let rotation = reduceMotion ? 0 : t * 1.2
    return AngularGradient(
      stops: [
        .init(color: .clear, location: 0.00),
        .init(color: accent.glow.opacity(0.13 + 0.09 * chorusDrop), location: 0.035),
        .init(color: .clear, location: 0.08),
        .init(color: .clear, location: 0.20),
        .init(color: accent.soft.opacity(0.09 + 0.07 * roomEnergy), location: 0.235),
        .init(color: .clear, location: 0.29),
        .init(color: .clear, location: 0.50),
        .init(color: accent.glow.opacity(0.11), location: 0.535),
        .init(color: .clear, location: 0.59),
        .init(color: .clear, location: 1.00),
      ],
      center: .center,
      angle: .degrees(rotation)
    )
    .frame(width: size.width * 1.25, height: size.width * 1.25)
    .position(x: size.width / 2, y: size.height * 0.54)
    .mask(
      RadialGradient(
        colors: [.white.opacity(0.9), .white.opacity(0.25), .clear],
        center: .center,
        startRadius: 80,
        endRadius: size.width * 0.62
      )
    )
    .blendMode(.screen)
  }
}

/// A chorus should feel like the room just got the memo. The card lives behind
/// the lyric ladder, so it can be enormous without delaying a single word.
private struct ChorusDropPlate: View {
  let progress: Double
  let finale: Bool
  let accent: AccentPalette
  let reduceMotion: Bool

  var body: some View {
    let visible = min(1, max(0, progress))
    let travel = reduceMotion ? 0 : 34 * (1 - visible)
    VStack(spacing: 12) {
      Text(finale ? "ONE MORE TIME" : "EVERYBODY")
        .font(Tokens.display(finale ? 134 : 166, .black))
        .tracking(finale ? 12 : 18)
        .foregroundStyle(accent.soft.opacity(0.075 * visible))
        .lineLimit(1)
        .minimumScaleFactor(0.7)

      HStack(spacing: 12) {
        Capsule().fill(accent.accent.opacity(0.34 * visible)).frame(width: 110, height: 2)
        Circle().fill(accent.soft.opacity(0.72 * visible)).frame(width: 7, height: 7)
        Capsule().fill(accent.accent.opacity(0.34 * visible)).frame(width: 110, height: 2)
      }
    }
    .offset(y: -travel)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .padding(.top, 154)
    .opacity(visible)
  }
}

/// Persistent, whisper-quiet instructions for the control-free stage.
struct StageModeHUD: View {
  let mode: String
  let accent: Color
  let energy: Double

  var body: some View {
    HStack(alignment: .center) {
      HStack(spacing: 12) {
        Circle()
          .fill(accent)
          .frame(width: 7, height: 7)
          .shadow(color: accent.opacity(0.75), radius: 8)
        Text(mode.uppercased())
      }
      Spacer()
      HStack(spacing: 10) {
        Image(systemName: "sparkles")
        Text(energy > 0.2 ? "ROOM IS UP" : "CLICK FOR CONTROLS")
      }
    }
    .font(Tokens.display(18, .semibold))
    .tracking(3.2)
    .foregroundStyle(Tokens.text3)
    .padding(.horizontal, Tokens.safeX)
    .padding(.top, 46)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
