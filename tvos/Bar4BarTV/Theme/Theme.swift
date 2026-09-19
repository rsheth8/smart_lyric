import SwiftUI
import CoreText
import Bar4BarCore

/// Shared typography, surfaces, and motion for the television app.
enum Tokens {

  // MARK: - Brand

  /// Violet. The brand constant — matches the icon's glow and the Glass
  /// spotlight. Per-song artwork accents fall back to this.
  static let accentStatic = Color(hex: 0x8B5CF6)
  static let accentSoft = Color(hex: 0xA78BFA)
  /// Text ON an accent fill — near-white for legibility on violet.
  static let accentInk = Color(hex: 0xF5F3FF)
  /// Vermilion — kept for Apple Music brand and semantic error/heat states.
  static let ember = Color(hex: 0xEF684B)

  // MARK: - Surfaces (elevation: 0 = the room, 3 = closest to you)

  static let surface0 = Color(hex: 0x07040E)   // concert black — near pure, violet undertone
  static let surface1 = Color.white.opacity(0.040)
  static let surface2 = Color.white.opacity(0.075)
  static let surface3 = Color.white.opacity(0.12)
  /// Opaque variants — for anything sitting over a blur/material.
  static let surfaceSolid1 = Color(hex: 0x07040E)
  static let surfaceSolid2 = Color(hex: 0x16092B)
  static let scrim = Color(hex: 0x07040E).opacity(0.82)

  // MARK: - Hairlines

  static let line1 = Color.white.opacity(0.08)
  static let line2 = Color.white.opacity(0.14)
  static let line3 = Color.white.opacity(0.22)

  // MARK: - Text

  static let ink = Color(hex: 0xF2EBDD)
  static let text1 = Color(hex: 0xF2EBDD)
  static let text2 = Color(hex: 0xF2EBDD).opacity(0.72)
  static let text3 = Color(hex: 0xF2EBDD).opacity(0.55)

  // MARK: - Semantic

  static let ok = Color(hex: 0x78E6A0)
  static let warn = Color(hex: 0xFFC46E)
  static let error = ember

  // MARK: - Lyric word states

  static let wordDim = Color(hex: 0xF2EBDD).opacity(0.28)
  static let wordUpcoming = Color(hex: 0xF2EBDD).opacity(0.42)
  /// A word already sung stays full ink — the accent marks the *current* word.
  static let wordSung = text1

  // MARK: - Glass (performance stage)
  enum Glass {
    static let envelope      = Color(hex: 0x030108)   // near-pure black, cool violet
    static let fieldFallback = Color(hex: 0x1E0838)   // deep concert violet fallback
    static let filament      = Color(hex: 0xF6F0FF)   // near-white, barely violet — cooler than before
    static let filamentDim   = Color(hex: 0xF6F0FF).opacity(0.28)
    static let filamentSung  = Color(hex: 0xF6F0FF).opacity(0.65)
    static let meter         = Color(hex: 0x00EDFF)   // neon cyan (was flat blue)
    static let legend        = Color(hex: 0xF6F0FF).opacity(0.40)
    static let holdHorizon   = Color(hex: 0x00EDFF).opacity(0.95)
    static let spotlight     = Color(hex: 0x8B5CF6)   // concert violet, used for stage-light cone
  }

  // MARK: - Type (TV density)

  enum FontSize {
    static let xs: CGFloat = 20
    static let sm: CGFloat = 24
    static let base: CGFloat = 28
    static let md: CGFloat = 34
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
  static let ringWidth: CGFloat = 2
  static let ringLift: CGFloat = -2

  // MARK: - Lyric depth-of-field (body[data-surface="tv"] .line states)

  enum DOF {
    static let idleOpacity: Double = 0.12
    static let idleBlur: CGFloat = 0
    static let pastOpacity: Double = 0.22
    static let pastBlur: CGFloat = 0
    static let nextOpacity: Double = 0.52
    static let nextBlur: CGFloat = 0
    static let prepOpacity: Double = 0.70
    static let prepBlur: CGFloat = 0
  }

  // MARK: - Motion

  enum Motion {
    static let fast: Double = 0.12
    static let normal: Double = 0.24
    static let slow: Double = 0.55
    /// `--ease-out: cubic-bezier(.16, 1, .3, 1)`
    static let easeOut = Animation.smooth(duration: normal, extraBounce: 0)
    static let lyric = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.48)
    /// Line placement on the ladder — longer than `lyric` so a 4K panel does
    /// not see the neighbors jump.
    static let stage = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.78)
    static let easeOutSlow = Animation.timingCurve(0.16, 1, 0.3, 1, duration: slow)
    /// Chrome and lyric-band inset. Shorter than `stage` so the remote feels instant.
    static let chrome = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.42)
    /// Hub / search content settling.
    static let page = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.52)
  }

  // MARK: - Type helpers

  static let lilac = Color(hex: 0xC77DFF)       // hotter concert purple (was muted lilac)
  static let chartreuse = Color(hex: 0xD8E77B)

  private static let fontCache = NSCache<NSString, FontBox>()
  private static let fontLock = NSLock()
  private final class FontBox { let font: CTFont; init(_ font: CTFont) { self.font = font } }

  /// CoreText supplies fallback runs for scripts outside the bundled faces.
  static func typeface(_ size: CGFloat, editorial: Bool = false, italic: Bool = false) -> CTFont {
    fontLock.lock(); defer { fontLock.unlock() }
    fontCache.countLimit = 128
    let key = "\(size)-\(editorial)-\(italic)" as NSString
    if let cached = fontCache.object(forKey: key) { return cached.font }
    let name = editorial ? (italic ? "Fraunces-9ptBlackItalic" : "Fraunces-9ptBlack") : "Manrope-ExtraLight"
    let axes: [NSNumber: NSNumber] = editorial
      ? [0x77676874: 650, 0x6F70737A: 96, 0x534F4654: 45, 0x574F4E4B: 1]
      : [0x77676874: 600]
    let descriptor = CTFontDescriptorCreateWithAttributes([
      kCTFontNameAttribute: name, kCTFontVariationAttribute: axes
    ] as CFDictionary)
    let font = CTFontCreateWithFontDescriptor(descriptor, size, nil)
    fontCache.setObject(FontBox(font), forKey: key)
    return font
  }
  static func lyric(_ size: CGFloat) -> Font { Font(typeface(size, editorial: true)) }
  static func editorial(_ size: CGFloat, italic: Bool = false) -> Font {
    Font(typeface(size, editorial: true, italic: italic))
  }
  static func caption(_ size: CGFloat = 20) -> Font { Font(typeface(size)) }
  static func control(_ size: CGFloat = 24) -> Font { Font(typeface(size)) }
  static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
    Font(typeface(size))
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
  /// vermilion whenever the artwork can't support one.
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
