import SwiftUI
import Bar4BarCore

/// Album art as the instrumental photograph. Slow drift, no blur — blur on a
/// full-panel image is what made the stage feel filmed and drop frames.
struct PictureArtwork: View {
  let url: URL?
  let tint: Color
  let amount: Double

  var body: some View {
    let opacity = 0.22 * amount
    ZStack {
      if let url {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image.resizable().scaledToFill()
          default:
            tintPlate
          }
        }
      } else {
        tintPlate
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .scaleEffect(1.08)
    .opacity(opacity)
    .clipped()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private var tintPlate: some View {
    LinearGradient(
      colors: [tint.opacity(0.85), tint.opacity(0.25)],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
}

/// Song-start plate. Full card over a long intro; compact lockup when vocals
/// are already on screen so the opening line is never covered.
struct EntrancePlate: View {
  let title: String
  let artist: String
  let artworkURL: URL?
  let tint: Color
  let fullCard: Bool
  let opacity: Double

  var body: some View {
    Group {
      if fullCard {
        VStack(spacing: Tokens.Space.s4) {
          CoverArt(url: artworkURL, side: 280, corner: Tokens.Radius.xl, fallbackTint: tint)
          Text("NOW")
            .font(Tokens.display(22, .semibold))
            .tracking(6)
            .foregroundStyle(Tokens.text3)
          Text(title)
            .font(Tokens.display(64, .bold))
            .foregroundStyle(Tokens.text1)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
          Text(artist)
            .font(Tokens.display(34, .medium))
            .foregroundStyle(Tokens.text2)
            .lineLimit(1)
        }
        .padding(.horizontal, Tokens.safeX)
      } else {
        VStack(spacing: 8) {
          Text(title)
            .font(Tokens.display(40, .semibold))
            .foregroundStyle(Tokens.text1)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
          Text(artist)
            .font(Tokens.display(24, .medium))
            .foregroundStyle(Tokens.text2)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 48)
      }
    }
    .opacity(opacity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// Last-chorus freeze after the final lyric. The wipe is already complete.
struct AfterglowPlate: View {
  let line: LyricLine
  let freezeAt: Double
  let progress: Double
  let title: String
  let accent: AccentPalette

  var body: some View {
    let fade = progress < 0.72 ? 1.0 : max(0, 1 - (progress - 0.72) / 0.28)
    VStack(spacing: Tokens.Space.s4) {
      LyricLineView(
        line: line,
        t: freezeAt,
        depth: .active,
        accent: accent,
        look: .anthem,
        dense: false,
        finale: true,
        typeSize: 108
      )
      Text(title)
        .font(Tokens.display(28, .medium))
        .foregroundStyle(Tokens.text3)
        .lineLimit(1)
    }
    .padding(.horizontal, Tokens.safeX)
    .opacity(fade)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

struct StageCheer: Identifiable {
  let id = UUID()
  let born: Date
  let seed: Double
}

/// Gold embers on Select. Not a score. Reduce Motion is a single soft flash.
struct CheerField: View {
  let cheers: [StageCheer]
  let now: Date
  let accent: Color
  let reduceMotion: Bool

  var body: some View {
    GeometryReader { geo in
      ForEach(live) { cheer in
        let age = now.timeIntervalSince(cheer.born)
        let u = min(1, max(0, age / StageDirection.cheerDuration))
        if reduceMotion {
          Rectangle()
            .fill(accent.opacity(0.10 * (1 - u)))
        } else {
          embers(seed: cheer.seed, u: u, size: geo.size)
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private var live: [StageCheer] {
    cheers.filter { now.timeIntervalSince($0.born) < StageDirection.cheerDuration }
  }

  private func embers(seed: Double, u: Double, size: CGSize) -> some View {
    let originX = 0.18 + 0.64 * seed
    let burst = sin(min(1, u * 2.2) * .pi / 2)
    return ZStack {
      // The whole panel gives a tiny flash, like an audience phone catching
      // the lens. It makes one press readable even from the back of a room.
      RadialGradient(
        colors: [accent.opacity(0.12 * (1 - u)), .clear],
        center: UnitPoint(x: originX, y: 0.82),
        startRadius: 0,
        endRadius: size.width * 0.42
      )

      ForEach(0..<14, id: \.self) { i in
        let frac = Double(i) / 14.0
        let spread = (frac - 0.5) * (0.58 + 0.20 * seed)
        let x = originX + spread * burst + 0.025 * sin(seed * 19 + frac * 24)
        let rise = 0.10 + 0.70 * u + 0.13 * sin(frac * .pi)
        Capsule()
          .fill(accent.opacity((1 - u) * (0.46 + 0.34 * sin(frac * .pi))))
          .frame(width: 4 + 3 * (1 - u), height: 16 + 28 * (1 - u))
          .rotationEffect(.degrees(spread * 54))
          .shadow(color: accent.opacity(0.5 * (1 - u)), radius: 8)
          .position(
            x: size.width * x,
            y: size.height * (1.08 - rise)
          )
      }

      Capsule()
        .fill(accent.opacity(0.28 * (1 - u)))
        .frame(width: size.width * (0.08 + 0.34 * burst), height: 3)
        .shadow(color: accent.opacity(0.55 * (1 - u)), radius: 16)
        .position(x: size.width * originX, y: size.height * 0.94)
    }
  }
}
