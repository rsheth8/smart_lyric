import SwiftUI
import Bar4BarCore

/// Bar4Bar "Dark Luxury" design tokens for tvOS — the Swift port of
/// `app/styles/tokens.css` at its `[data-surface="tv"]` density.
///
/// Two rules carried over from the CSS:
///
/// 1. Nothing below this file hard-codes a color. If you are typing
///    `Color.white.opacity(0.06)` into a view, the token you want is `surface2`.
/// 2. Identity is champagne gold on warm espresso, but `accent` is REASSIGNED
///    PER SONG from the album artwork (see `AccentPalette`), which is why views
///    must read `theme.accent` and never the literal gold.
///
/// The tvOS density is not the desktop scale: this file *is* the TV branch, so
/// the sizes below correspond to `body[data-surface="tv"]`, already doubled for
/// a 1920pt canvas viewed from across the room.
enum Tokens {

  // MARK: - Brand

  /// Champagne gold. The brand constant — never overwritten. Per-song accents
  /// fall back to exactly this when the artwork can't supply a usable hue.
  static let accentStatic = Color(hex: 0xE3C27A)
  static let accentSoft = Color(hex: 0xF4E3BD)
  /// Text ON an accent fill.
  static let accentInk = Color(hex: 0x171106)
  /// The brand "4". Not the gold — a genuinely different color.
  static let ember = Color(hex: 0xFF715B)

  // MARK: - Surfaces (elevation: 0 = the room, 3 = closest to you)

  static let surface0 = Color(hex: 0x0B0908)
  static let surface1 = Color.white.opacity(0.035)
  static let surface2 = Color.white.opacity(0.065)
  static let surface3 = Color.white.opacity(0.10)
  /// Opaque variants — for anything sitting over a blur/material.
  static let surfaceSolid1 = Color(hex: 0x100D0B)
  static let surfaceSolid2 = Color(hex: 0x16120F)
  static let scrim = Color(hex: 0x0B0908).opacity(0.76)

  // MARK: - Hairlines

  static let line1 = Color.white.opacity(0.08)
  static let line2 = Color.white.opacity(0.14)
  static let line3 = Color.white.opacity(0.22)

  // MARK: - Text

  static let ink = Color(hex: 0xF6F0E4)
  static let text1 = Color(hex: 0xF6F0E4)
  static let text2 = Color(hex: 0xF6F0E4).opacity(0.62)
  static let text3 = Color(hex: 0xF6F0E4).opacity(0.38)

  // MARK: - Semantic

  static let ok = Color(hex: 0x78E6A0)
  static let warn = Color(hex: 0xFFC46E)
  static let error = ember

  // MARK: - Lyric word states

  static let wordDim = Color(hex: 0xF6F0E4).opacity(0.28)
  static let wordUpcoming = Color(hex: 0xF6F0E4).opacity(0.42)
  /// A word already sung stays full ink — the accent marks the *current* word.
  static let wordSung = text1

  // MARK: - Type (TV density)

  enum FontSize {
    static let xs: CGFloat = 15
    static let sm: CGFloat = 18
    static let base: CGFloat = 24
    static let md: CGFloat = 28
    static let lg: CGFloat = 34
    static let xl: CGFloat = 46
    static let xxl: CGFloat = 62
  }

  // MARK: - Space (TV density)

  enum Space {
    static let s1: CGFloat = 6
    static let s2: CGFloat = 12
    static let s3: CGFloat = 20
    static let s4: CGFloat = 30
    static let s5: CGFloat = 44
    static let s6: CGFloat = 64
  }

  // MARK: - Radii

  enum Radius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 22
    static let xxl: CGFloat = 28
    static let pill: CGFloat = 999
  }

  // MARK: - Layout

  /// Broadcast-safe overscan inset so nothing lands off the panel edge.
  /// 5vw/5vh of a 1920×1080 canvas, matching `--safe-x` / `--safe-y`.
  static let safeX: CGFloat = 96
  static let safeY: CGFloat = 54
  static let cardW: CGFloat = 260
  static let ringWidth: CGFloat = 4
  static let ringLift: CGFloat = -6

  // MARK: - Lyric depth-of-field (body[data-surface="tv"] .line states)

  enum DOF {
    static let idleOpacity: Double = 0.12
    static let idleBlur: CGFloat = 2.0
    static let pastOpacity: Double = 0.05
    static let pastBlur: CGFloat = 2.6
    static let nextOpacity: Double = 0.52
    static let nextBlur: CGFloat = 0.5
    static let prepOpacity: Double = 0.70
    static let prepBlur: CGFloat = 0.12
  }

  // MARK: - Motion

  enum Motion {
    static let fast: Double = 0.14
    static let normal: Double = 0.28
    static let slow: Double = 0.55
    /// `--ease-out: cubic-bezier(.16, 1, .3, 1)`
    static let easeOut = Animation.timingCurve(0.16, 1, 0.3, 1, duration: normal)
    static let easeOutSlow = Animation.timingCurve(0.16, 1, 0.3, 1, duration: slow)
  }

  // MARK: - Type helpers

  /// The brand face is SF Pro Display bold — emphatically *not* `.rounded`,
  /// which reads friendly/toylike and undercuts "premium on a projector".
  static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
    .system(size: size, weight: weight, design: .default)
  }
}

// MARK: - Per-song accent

/// SwiftUI face of `AccentMath`. The rule itself (hue-only rebuild in the
/// brand's OKLCh band, greyscale + contrast fallbacks) lives in Bar4BarCore
/// where it is unit-tested; this only turns the result into `Color`s.
struct AccentPalette: Equatable {
  var accent: Color
  var soft: Color
  /// The glow tone, used for backdrops rather than text.
  var glow: Color

  static let brand = AccentPalette(
    accent: Tokens.accentStatic,
    soft: Tokens.accentSoft,
    glow: Tokens.accentStatic
  )

  /// Build an accent from a dominant artwork color, falling back to the brand
  /// gold whenever the artwork can't support one.
  static func from(dominant rgb: RGB) -> AccentPalette {
    guard let built = AccentMath.rebuild(dominant: rgb) else { return .brand }
    return AccentPalette(
      accent: built.accent.color,
      soft: built.soft.color,
      glow: built.glow.color
    )
  }
}

extension RGB {
  var color: Color {
    Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
  }
}

extension Color {
  init(hex: UInt32) {
    self = RGB(hex).color
  }
}
