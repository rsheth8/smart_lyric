import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import Bar4BarCore

/// Shared focus treatment.
///
/// tvOS focus is the entire navigation model — at ten feet the ring is not
/// decoration, it is the cursor. These styles port the Electron app's
/// ring + halo + lift so the two surfaces feel like one product.

// MARK: - Pill

struct TVPillStyle: ButtonStyle {
  var tint: Color = Tokens.text1

  func makeBody(configuration: Configuration) -> some View {
    PillBody(configuration: configuration, tint: tint)
  }

  private struct PillBody: View {
    let configuration: Configuration
    let tint: Color
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .font(Tokens.display(Tokens.FontSize.base, .semibold))
        .foregroundStyle(focused ? Tokens.accentInk : tint)
        .padding(.horizontal, Tokens.Space.s4)
        .padding(.vertical, Tokens.Space.s3)
        .background(focused ? Tokens.accentStatic : Tokens.surface2, in: Capsule())
        .overlay(
          Capsule().stroke(focused ? Color.clear : Tokens.line1, lineWidth: 1)
        )
        .shadow(
          color: focused ? Tokens.accentStatic.opacity(0.35) : .clear,
          radius: focused ? 22 : 0,
          y: focused ? 8 : 0
        )
        .scaleEffect(configuration.isPressed ? 0.96 : (focused ? 1.06 : 1))
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - Action card

/// A large, focusable tile — the hub's primary affordance. Sized for a remote,
/// not a cursor.
struct TVActionCardStyle: ButtonStyle {
  var accent: Color = Tokens.accentStatic

  func makeBody(configuration: Configuration) -> some View {
    CardBody(configuration: configuration, accent: accent)
  }

  private struct CardBody: View {
    let configuration: Configuration
    let accent: Color
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Tokens.Space.s5)
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.xxl, style: .continuous)
            .fill(focused ? Tokens.surface3 : Tokens.surface1)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Tokens.Radius.xxl, style: .continuous)
            .stroke(focused ? accent : Tokens.line1, lineWidth: focused ? Tokens.ringWidth : 1)
        )
        .shadow(
          color: focused ? accent.opacity(0.28) : .black.opacity(0.35),
          radius: focused ? 34 : 14,
          y: focused ? 14 : 6
        )
        .scaleEffect(configuration.isPressed ? 0.985 : (focused ? 1.03 : 1))
        .offset(y: focused ? Tokens.ringLift : 0)
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - Poster

/// Artwork tile focus treatment.
///
/// tvOS's stock `.card` style is the platform default, but it draws its own
/// light plate behind the content, which on the espresso ground reads as a grey
/// box around every cover. This keeps the lift and shadow people expect from a
/// TV poster and swaps the plate for the app's gold ring.
struct TVPosterStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    PosterBody(configuration: configuration)
  }

  private struct PosterBody: View {
    let configuration: Configuration
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .overlay(alignment: .top) {
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .stroke(focused ? Tokens.accentStatic : Color.clear, lineWidth: Tokens.ringWidth)
            .frame(width: Tokens.cardW, height: Tokens.cardW)
        }
        .shadow(
          color: focused ? Tokens.accentStatic.opacity(0.30) : .black.opacity(0.4),
          radius: focused ? 30 : 10,
          y: focused ? 14 : 5
        )
        .scaleEffect(configuration.isPressed ? 0.97 : (focused ? 1.06 : 1))
        .offset(y: focused ? Tokens.ringLift : 0)
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - Icon pill

/// A circular icon button — used for steppers, where a `−` / `+` label in a
/// full-width pill would be mostly empty space.
struct TVIconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    IconBody(configuration: configuration)
  }

  private struct IconBody: View {
    let configuration: Configuration
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .font(Tokens.display(Tokens.FontSize.md, .semibold))
        .foregroundStyle(focused ? Tokens.accentInk : Tokens.text1)
        .frame(width: 66, height: 66)
        .background(focused ? Tokens.accentStatic : Tokens.surface2, in: Circle())
        .overlay(Circle().stroke(focused ? Color.clear : Tokens.line1, lineWidth: 1))
        .shadow(
          color: focused ? Tokens.accentStatic.opacity(0.35) : .clear,
          radius: focused ? 20 : 0,
          y: focused ? 6 : 0
        )
        .scaleEffect(configuration.isPressed ? 0.94 : (focused ? 1.08 : 1))
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - Settings primitives

/// A titled group of settings rows.
///
/// tvOS's stock `Form` was what Settings used to be, and it brought its own
/// grey-blue background and system row chrome with it — the one screen in the
/// app that looked like someone else's product. This is the replacement: same
/// grouping idea, built from the same tokens as everything else.
struct TVGroup<Content: View>: View {
  let title: String
  var footnote: String? = nil
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      Text(title.uppercased())
        .font(Tokens.display(Tokens.FontSize.sm, .semibold))
        .tracking(1.6)
        .foregroundStyle(Tokens.text3)

      VStack(spacing: 0) { content }
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
            .fill(Tokens.surface1)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
            .stroke(Tokens.line1, lineWidth: 1)
        )

      if let footnote {
        // Deliberately outside the card. Inside the old Form it rendered as a
        // row, which made a paragraph of explanation look pressable.
        Text(footnote)
          .font(Tokens.display(Tokens.FontSize.xs, .regular))
          .foregroundStyle(Tokens.text3)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, Tokens.Space.s2)
      }
    }
  }
}

/// A non-interactive label/value row.
struct TVInfoRow: View {
  let label: String
  let value: String
  var tint: Color = Tokens.text2
  var mono: Bool = false

  var body: some View {
    HStack {
      Text(label)
        .font(Tokens.display(Tokens.FontSize.base, .medium))
        .foregroundStyle(Tokens.text1)
      Spacer(minLength: Tokens.Space.s4)
      Text(value)
        .font(Tokens.display(Tokens.FontSize.base, mono ? .semibold : .regular))
        .monospacedDigit()
        .foregroundStyle(tint)
        .multilineTextAlignment(.trailing)
        .lineLimit(2)
    }
    .padding(.horizontal, Tokens.Space.s4)
    .padding(.vertical, Tokens.Space.s3)
  }
}

/// Label, current value, and −/+ — the shape every timing control in this app
/// wants. A TV has no drag affordance, so a stepper beats a slider.
struct TVStepperRow: View {
  let label: String
  let value: String
  var hint: String? = nil
  let onDecrease: () -> Void
  let onIncrease: () -> Void

  var body: some View {
    HStack(spacing: Tokens.Space.s4) {
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(Tokens.display(Tokens.FontSize.base, .medium))
          .foregroundStyle(Tokens.text1)
        if let hint {
          Text(hint)
            .font(Tokens.display(Tokens.FontSize.xs, .regular))
            .foregroundStyle(Tokens.text3)
        }
      }
      Spacer(minLength: Tokens.Space.s4)
      Text(value)
        .font(Tokens.display(Tokens.FontSize.md, .semibold))
        .monospacedDigit()
        .foregroundStyle(Tokens.accentStatic)
        .frame(minWidth: 150, alignment: .trailing)
      Button { onDecrease() } label: { Image(systemName: "minus") }
        .buttonStyle(TVIconButtonStyle())
      Button { onIncrease() } label: { Image(systemName: "plus") }
        .buttonStyle(TVIconButtonStyle())
    }
    .padding(.horizontal, Tokens.Space.s4)
    .padding(.vertical, Tokens.Space.s3)
  }
}

/// A full-width pressable row inside a `TVGroup`.
struct TVActionRow: View {
  let title: String
  var subtitle: String? = nil
  var icon: String? = nil
  var tint: Color = Tokens.text1
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: Tokens.Space.s3) {
        if let icon {
          Image(systemName: icon)
            .font(.system(size: Tokens.FontSize.base))
            .frame(width: 36)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(Tokens.display(Tokens.FontSize.base, .medium))
          if let subtitle {
            Text(subtitle)
              .font(Tokens.display(Tokens.FontSize.xs, .regular))
              .opacity(0.7)
          }
        }
        Spacer()
      }
    }
    .buttonStyle(TVRowStyle(tint: tint))
  }
}

/// Focus treatment for a row that fills the width of its group.
struct TVRowStyle: ButtonStyle {
  var tint: Color = Tokens.text1

  func makeBody(configuration: Configuration) -> some View {
    RowBody(configuration: configuration, tint: tint)
  }

  private struct RowBody: View {
    let configuration: Configuration
    let tint: Color
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .padding(.horizontal, Tokens.Space.s4)
        .padding(.vertical, Tokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .fill(focused ? Tokens.accentStatic : Color.clear)
        )
        // Focused rows flip to ink-on-gold, so the label colour has to invert
        // with them or it vanishes into the fill.
        .foregroundStyle(focused ? Tokens.accentInk : tint)
        // No focus scale here, unlike the free-standing pills and cards: a row
        // is inset inside a `TVGroup`, and scaling it pushes the gold fill out
        // past the group's own rounded border.
        .scaleEffect(configuration.isPressed ? 0.99 : 1)
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - Brand lockup

/// "Bar4Bar" with the ember "4" — the one place the ember brand color is used,
/// exactly as in the web app.
struct BrandLockup: View {
  var size: CGFloat = Tokens.FontSize.xxl

  var body: some View {
    HStack(spacing: 0) {
      Text("Bar").foregroundStyle(Tokens.accentStatic)
      Text("4").foregroundStyle(Tokens.ember)
      Text("Bar").foregroundStyle(Tokens.accentStatic)
    }
    .font(Tokens.display(size, .bold))
    .shadow(color: Tokens.accentStatic.opacity(0.25), radius: 30, y: 6)
  }
}

/// The B4B badge — the app icon's mark, rendered in type.
///
/// The web hub carries it beside the wordmark and the TV app did not, which is
/// most of why the tvOS header read as a title rather than a brand. It is a
/// glowing plate, not a flat square: the inner shadow is what keeps it from
/// looking like an empty input field.
struct BrandMark: View {
  var side: CGFloat = 84

  var body: some View {
    // Three runs in an HStack, not one string with a colored overlay: an
    // overlaid "4" centres on the *whole* string's box rather than on the
    // glyph, which renders as a smear.
    HStack(spacing: 0) {
      Text("B").foregroundStyle(Tokens.accentSoft)
      Text("4").foregroundStyle(Tokens.ember)
      Text("B").foregroundStyle(Tokens.accentSoft)
    }
    .font(Tokens.display(side * 0.30, .heavy))
    .frame(width: side, height: side)
      .background(
        RoundedRectangle(cornerRadius: Tokens.Radius.md + 1, style: .continuous)
          .fill(Tokens.surface0)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Tokens.Radius.md + 1, style: .continuous)
          .stroke(Tokens.accentStatic.opacity(0.46), lineWidth: 1)
      )
      .shadow(color: Tokens.accentStatic.opacity(0.20), radius: 24)
  }
}

// MARK: - Shelf

/// The row heading above a shelf.
///
/// Small, uppercase, letter-spaced, and in secondary ink — deliberately quieter
/// than the artwork below it. The tvOS hub previously used large primary-ink
/// titles, which made the labels compete with the covers they were introducing.
struct ShelfHeader<Trailing: View>: View {
  let title: String
  var subtitle: String? = nil
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s3) {
      Text(title.uppercased())
        .font(Tokens.display(Tokens.FontSize.sm, .semibold))
        .tracking(1.6)
        .foregroundStyle(Tokens.text2)
      if let subtitle {
        Text(subtitle)
          .font(Tokens.display(Tokens.FontSize.sm, .regular))
          .foregroundStyle(Tokens.text3)
      }
      Spacer(minLength: 0)
      trailing
    }
  }
}

extension ShelfHeader where Trailing == EmptyView {
  init(_ title: String, subtitle: String? = nil) {
    self.init(title: title, subtitle: subtitle) { EmptyView() }
  }
}

/// A poster card: cover, title, artist.
struct PosterCard: View {
  let item: CatalogItem
  var onPlay: () -> Void

  var body: some View {
    Button(action: onPlay) {
      VStack(alignment: .leading, spacing: Tokens.Space.s2) {
        CoverArt(url: item.artworkURL, side: Tokens.cardW)
        Text(item.title)
          .font(Tokens.display(Tokens.FontSize.base, .semibold))
          .foregroundStyle(Tokens.text1)
          .lineLimit(1)
          .frame(width: Tokens.cardW, alignment: .leading)
        Text(item.artist)
          .font(Tokens.display(Tokens.FontSize.sm, .regular))
          .foregroundStyle(Tokens.text2)
          .lineLimit(1)
          .frame(width: Tokens.cardW, alignment: .leading)
      }
    }
    .buttonStyle(TVPosterStyle())
  }
}

/// Album art with a branded placeholder.
///
/// The fade-in matters more than it sounds: twelve covers arriving at slightly
/// different moments pop into place one by one, and popping reads as jank where
/// a 0.3s fade reads as loading.
struct CoverArt: View {
  let url: URL?
  var side: CGFloat
  var corner: CGFloat = Tokens.Radius.lg
  /// Stands in when there is no image to load. The demo track has a dominant
  /// color but no cover, and a grey plate with a music glyph would undersell
  /// the one song the app ships with.
  var fallbackTint: Color? = nil

  var body: some View {
    Group {
      if let url {
        AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.3))) { phase in
          switch phase {
          case .success(let image):
            image.resizable().scaledToFill().transition(.opacity)
          case .failure:
            placeholder
          default:
            shimmer
          }
        }
      } else {
        placeholder
      }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
    .overlay(
      // Covers are photographs and many are light-edged; without a hairline they
      // bleed into the espresso ground and lose their shape.
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .stroke(Tokens.line1, lineWidth: 1)
    )
  }

  @ViewBuilder
  private var placeholder: some View {
    if let tint = fallbackTint {
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .fill(
          LinearGradient(
            colors: [tint.opacity(0.85), tint.opacity(0.30)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
        .overlay {
          BrandLockup(size: side * 0.17)
        }
    } else {
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .fill(Tokens.surface2)
        .overlay {
          Image(systemName: "music.note")
            .font(.system(size: side * 0.24))
            .foregroundStyle(Tokens.accentStatic.opacity(0.55))
        }
    }
  }

  private var shimmer: some View {
    RoundedRectangle(cornerRadius: corner, style: .continuous)
      .fill(Tokens.surface1)
  }
}

/// Placeholder card shown while the chart shelf is in flight.
///
/// The web hub ships these too. A shelf that pops in from nothing makes the
/// whole page jump; reserving the space keeps the layout still.
struct SkeletonCard: View {
  @State private var shimmer = false

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s2) {
      RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
        .fill(Tokens.surface1)
        .frame(width: Tokens.cardW, height: Tokens.cardW)
      RoundedRectangle(cornerRadius: 4).fill(Tokens.surface1)
        .frame(width: Tokens.cardW * 0.8, height: Tokens.FontSize.base * 0.7)
      RoundedRectangle(cornerRadius: 4).fill(Tokens.surface1)
        .frame(width: Tokens.cardW * 0.5, height: Tokens.FontSize.sm * 0.7)
    }
    .opacity(shimmer ? 0.75 : 0.4)
    .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: shimmer)
    .onAppear { shimmer = true }
  }
}

// MARK: - Source tile

/// A "Follow what's playing" entry: icon plate, label, one line of state.
///
/// Wider than tall and packed four across, mirroring the web hub — the shape is
/// what tells you these are sources rather than songs.
struct SourceTile: View {
  let icon: String
  let title: String
  let subtitle: String
  var tint: Color = Tokens.accentStatic
  /// Draws the connected dot. Distinct from focus, which is transient.
  var connected: Bool = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: Tokens.Space.s3) {
        Image(systemName: icon)
          .font(.system(size: Tokens.FontSize.md, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 62, height: 62)
          .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))

        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: Tokens.Space.s2) {
            Text(title)
              .font(Tokens.display(Tokens.FontSize.base, .semibold))
              .foregroundStyle(Tokens.text1)
              .lineLimit(1)
            if connected {
              Circle().fill(Tokens.ok).frame(width: 10, height: 10)
            }
          }
          Text(subtitle)
            .font(Tokens.display(Tokens.FontSize.sm, .regular))
            .foregroundStyle(Tokens.text2)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
    }
    .buttonStyle(TVTileStyle(tint: tint))
  }
}

struct TVTileStyle: ButtonStyle {
  var tint: Color = Tokens.accentStatic

  func makeBody(configuration: Configuration) -> some View {
    TileBody(configuration: configuration, tint: tint)
  }

  private struct TileBody: View {
    let configuration: Configuration
    let tint: Color
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .padding(Tokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
            .fill(focused ? Tokens.surface3 : Tokens.surface1)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
            .stroke(focused ? tint : Tokens.line1, lineWidth: focused ? Tokens.ringWidth : 1)
        )
        .shadow(
          color: focused ? tint.opacity(0.26) : .black.opacity(0.3),
          radius: focused ? 28 : 10,
          y: focused ? 12 : 4
        )
        .scaleEffect(configuration.isPressed ? 0.98 : (focused ? 1.04 : 1))
        .offset(y: focused ? Tokens.ringLift : 0)
        .animation(Tokens.Motion.easeOut, value: focused)
        .animation(.easeOut(duration: Tokens.Motion.fast), value: configuration.isPressed)
    }
  }
}

// MARK: - QR code

/// A QR code rendered on the espresso ground.
///
/// The alternative on a TV is asking someone to type a URL on a phone while
/// reading it off a screen across the room, which is the step every pairing
/// flow loses people at. CoreImage generates this locally — nothing is sent
/// anywhere to make it.
struct QRCode: View {
  let text: String
  var side: CGFloat = 260

  var body: some View {
    Group {
      if let image = Self.render(text) {
        Image(uiImage: image)
          .resizable()
          // No smoothing: a QR code is not a photograph, and interpolating it
          // softens the module edges that scanners key off.
          .interpolation(.none)
          .scaledToFit()
      } else {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .fill(Tokens.surface2)
      }
    }
    .frame(width: side, height: side)
    // A quiet zone of light around the symbol. Scanners need the margin, and
    // inverting the code to sit "on brand" against the dark ground would stop
    // many of them reading it at all.
    .padding(Tokens.Space.s2)
    .background(Color.white, in: RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
  }

  private static func render(_ text: String) -> UIImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    // Medium correction: the symbol stays small enough to read across a room
    // while tolerating a phone camera at an angle.
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    // CIQRCodeGenerator emits roughly one pixel per module; scale before
    // rasterising or the result is a blurry postage stamp.
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let context = CIContext()
    guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
}

// MARK: - Remote hints

/// The bottom hint strip. The web hub has one; on tvOS it is the only place the
/// remote's non-obvious gestures (swipe to trim sync) are ever spelled out.
struct HintBar: View {
  struct Hint: Identifiable {
    let id = UUID()
    let icon: String
    let label: String
  }
  let hints: [Hint]

  var body: some View {
    HStack(spacing: Tokens.Space.s5) {
      ForEach(hints) { hint in
        HStack(spacing: Tokens.Space.s2) {
          Image(systemName: hint.icon)
            .font(.system(size: Tokens.FontSize.sm, weight: .semibold))
          Text(hint.label)
            .font(Tokens.display(Tokens.FontSize.sm, .medium))
        }
        .foregroundStyle(Tokens.text3)
      }
    }
  }
}

// MARK: - Ambient background

/// The shared room: espresso ground, a slow accent glow, and a vignette.
struct AmbientBackdrop: View {
  var accent: Color = Tokens.accentStatic
  var intensity: Double = 1

  var body: some View {
    ZStack {
      Tokens.surface0

      RadialGradient(
        colors: [
          accent.opacity(0.20 * intensity),
          accent.opacity(0.05 * intensity),
          .clear,
        ],
        center: .init(x: 0.18, y: 0.12),
        startRadius: 0,
        endRadius: 1100
      )
      .blendMode(.screen)

      RadialGradient(
        colors: [.clear, .black.opacity(0.5)],
        center: .center,
        startRadius: 500,
        endRadius: 1300
      )
    }
    .ignoresSafeArea()
  }
}
