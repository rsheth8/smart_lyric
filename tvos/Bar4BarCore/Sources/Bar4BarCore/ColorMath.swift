import Foundation

/// sRGB triple in 0...1, plus the OKLab/OKLCh transform used by the
/// art-adaptive accent. Pure math with no UI dependency so it can be tested —
/// the SwiftUI bridging lives in the app target.
public struct RGB: Equatable, Sendable {
  public var r: Double
  public var g: Double
  public var b: Double

  public init(r: Double, g: Double, b: Double) {
    self.r = r
    self.g = g
    self.b = b
  }

  public init(_ hex: UInt32) {
    self.r = Double((hex >> 16) & 0xFF) / 255
    self.g = Double((hex >> 8) & 0xFF) / 255
    self.b = Double(hex & 0xFF) / 255
  }

  // MARK: sRGB <-> linear

  static func toLinear(_ c: Double) -> Double {
    c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
  }

  static func toGamma(_ c: Double) -> Double {
    c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055
  }

  /// WCAG relative luminance.
  public var luminance: Double {
    let rl = RGB.toLinear(r), gl = RGB.toLinear(g), bl = RGB.toLinear(b)
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
  }

  public func contrastRatio(against other: RGB) -> Double {
    let a = luminance, b = other.luminance
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }

  /// sRGB → OKLab → OKLCh (Björn Ottosson's transform, matching `app/theme.js`).
  public var oklch: OKLCH {
    let rl = RGB.toLinear(r), gl = RGB.toLinear(g), bl = RGB.toLinear(b)

    let l_ = cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl)
    let m_ = cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl)
    let s_ = cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl)

    let L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    let a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    let bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_

    var h = atan2(bb, a) * 180 / .pi
    if h < 0 { h += 360 }
    return OKLCH(l: L, c: sqrt(a * a + bb * bb), h: h)
  }

  static func fromLinear(r: Double, g: Double, b: Double) -> RGB {
    RGB(
      r: min(1, max(0, toGamma(r))),
      g: min(1, max(0, toGamma(g))),
      b: min(1, max(0, toGamma(b)))
    )
  }
}

public struct OKLCH: Equatable, Sendable {
  public var l: Double
  public var c: Double
  /// Hue in degrees, 0..<360.
  public var h: Double

  public init(l: Double, c: Double, h: Double) {
    self.l = l
    self.c = c
    self.h = h
  }

  public var rgb: RGB {
    let hr = h * .pi / 180
    let a = c * cos(hr)
    let b = c * sin(hr)

    let l_ = l + 0.3963377774 * a + 0.2158037573 * b
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b

    let l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_

    return RGB.fromLinear(
      r: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      g: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      b: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
    )
  }
}

/// The art-adaptive accent rule, ported from `app/theme.js` `accentFromPalette()`.
///
/// Takes only the HUE from the artwork's dominant color and REBUILDS it in
/// OKLCh at the brand's own band. Taking the hue and nothing else is the whole
/// trick: a muddy, neon, or washed-out cover still yields a tone that belongs
/// to this app rather than to the album.
public enum AccentMath {
  /// The brand band.
  public static let targetL = 0.82
  public static let maxC = 0.11
  /// Below this the artwork has no hue worth borrowing.
  public static let minChroma = 0.02
  public static let minContrast = 4.5
  /// The espresso ground the accent has to stay readable on.
  public static let ground = RGB(0x0B0908)

  public struct Rebuilt: Equatable, Sendable {
    public var accent: RGB
    public var soft: RGB
    public var glow: RGB
  }

  /// - Returns: the rebuilt trio, or nil when the caller should fall back to
  ///   the brand gold (near-greyscale art, or a result that fails contrast).
  public static func rebuild(dominant: RGB) -> Rebuilt? {
    let lch = dominant.oklch
    guard lch.c >= minChroma else { return nil }

    let c = min(lch.c, maxC)
    let accent = OKLCH(l: targetL, c: c, h: lch.h).rgb
    guard accent.contrastRatio(against: ground) >= minContrast else { return nil }

    return Rebuilt(
      accent: accent,
      soft: OKLCH(l: min(0.93, targetL + 0.09), c: c * 0.72, h: lch.h).rgb,
      glow: OKLCH(l: 0.70, c: min(lch.c, maxC * 1.3), h: lch.h).rgb
    )
  }
}
