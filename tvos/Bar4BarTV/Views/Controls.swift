import SwiftUI

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
