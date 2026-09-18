import SwiftUI
import CoreText
import Bar4BarCore

/// Bounded cache: outline construction and stippling never run in the frame loop.
enum InstallationForms {
  private static let cache = NSCache<NSString, Outline>()
  private static let lock = NSLock()
  final class Outline {
    let path: Path
    let bounds: CGRect
    init(_ path: CGPath) { self.path = Path(path); bounds = path.boundingBoxOfPath }
  }
  static func initials(_ title: String) -> String {
    let words = title.split(whereSeparator: { $0.isWhitespace || $0 == "-" })
    let result = words.compactMap { $0.first(where: { $0.isLetter || $0.isNumber }) }.prefix(2).map(String.init).joined().uppercased()
    return result.isEmpty ? "B4" : result
  }
  static func outline(_ text: String) -> Outline {
    lock.lock(); defer { lock.unlock() }
    cache.countLimit = 64
    if let cached = cache.object(forKey: text as NSString) { return cached }
    let font = Tokens.typeface(1000, editorial: true)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: String(text.prefix(12)),
      attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
    let shape = CGMutablePath()
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
      let count = CTRunGetGlyphCount(run)
      var glyphs = [CGGlyph](repeating: 0, count: count)
      var positions = [CGPoint](repeating: .zero, count: count)
      CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
      CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
      let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
      for index in 0..<count {
        if let glyph = CTFontCreatePathForGlyph(runFont, glyphs[index], nil) {
          let transform = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: positions[index].x, ty: -positions[index].y)
          shape.addPath(glyph, transform: transform)
        }
      }
    }
    let result = Outline(shape)
    cache.setObject(result, forKey: text as NSString)
    return result
  }
  static let stipple: Path = {
    var path = Path()
    var seed: UInt64 = 417
    for _ in 0..<1800 {
      seed = seed &* 6364136223846793005 &+ 1
      let x = CGFloat((seed >> 32) % 1920)
      seed = seed &* 6364136223846793005 &+ 1
      let y = CGFloat((seed >> 32) % 1080)
      path.addEllipse(in: CGRect(x: x, y: y, width: 1.4, height: 1.4))
    }
    return path
  }()
}

/// The same original letter installation surrounds browsing and the phrase board.
/// Travel uses the audible playback clock; audience accents use their own input clock.
struct PosterEnvironment: View {
  var state = StagePresentation()
  var intensity: StageIntensity = .focus
  var reduceMotion = false
  var letters = "B4"
  var cheer: Double = 0
  var featuredWord: String? = nil
  var browsing = false

  var body: some View {
    let forms = InstallationForms.outline(state.ending ? "B4B" : letters)
    let hook = state.kind == .chorus || state.kind == .finale
    let previousHook = state.previousKind == .chorus || state.previousKind == .finale
    let blend = state.sectionTransition * state.sectionTransition * (3 - 2 * state.sectionTransition)
    let hookAmount = (previousHook ? 1.0 : 0) + ((hook ? 1.0 : 0) - (previousHook ? 1.0 : 0)) * blend
    let shapeHook = reduceMotion || intensity == .focus ? (hook ? 1.0 : 0) : hookAmount
    let accent = Tokens.ember.mixed(with: Tokens.chartreuse, by: hookAmount)
    let strength = state.dense ? 0.12 : intensity.strength
    let drift = reduceMotion || intensity == .focus ? 0 : sin(state.motionTime * 0.19) * 30 * strength
    let expansion = reduceMotion || intensity == .focus ? 0 : shapeHook * 22 + state.build * 24 + (state.arrival + cheer) * 26 * strength
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Tokens.surface0))
      func letter(_ outline: InstallationForms.Outline, x: CGFloat, y: CGFloat, width: CGFloat, color: Color, alpha: Double, rotation: Double = 0) {
        guard outline.bounds.width > 0 else { return }
        var layer = context
        layer.translateBy(x: x, y: y)
        layer.rotate(by: .degrees(rotation))
        let scale = width / outline.bounds.width
        layer.scaleBy(x: scale, y: scale)
        layer.translateBy(x: -outline.bounds.minX, y: -outline.bounds.minY)
        layer.fill(outline.path, with: .color(color.opacity(alpha)))
      }
      // Unequal, cropped silhouettes rather than repeated frames or decorative bars.
      let width = size.width * (browsing ? 0.93 : state.kind == .instrumental || state.ending ? 0.78 : 0.64 + shapeHook * 0.12)
      let x = browsing ? size.width * 0.36 : size.width * 0.64
      let y = browsing ? size.height * 0.03 : -size.height * 0.23
      for depth in (1...4).reversed() {
        letter(forms, x: x + CGFloat(depth) * (11 + expansion * 0.25 + (state.hold != nil ? 8 : 0)),
          y: y + CGFloat(depth) * 13 + drift, width: width,
          color: Tokens.lilac, alpha: browsing ? 0.06 : 0.032 + strength * 0.014, rotation: -12)
      }
      letter(forms, x: x - expansion, y: y + drift, width: width,
        color: accent, alpha: browsing ? 0.38 : (state.dense ? 0.055 : 0.15 + hookAmount * 0.09) + cheer * 0.12, rotation: -12)
      letter(forms, x: -size.width * 0.25 - expansion, y: size.height * 0.71 - drift,
        width: size.width * 0.78, color: Tokens.lilac,
        alpha: state.dense ? 0.025 : 0.075 + strength * 0.025, rotation: 9)
      if let featuredWord, state.impact > 0, intensity != .focus {
        letter(InstallationForms.outline(featuredWord), x: size.width * 0.58,
          y: size.height * 0.06, width: size.width * 0.30,
          color: accent, alpha: 0.19 * state.impact)
      }
      // Quiet reading foreground: ink is layered over forms, never a lyric blur.
      if !browsing {
        context.fill(Path(CGRect(x: size.width * 0.075, y: size.height * 0.18,
          width: size.width * 0.85, height: size.height * 0.52)),
          with: .linearGradient(Gradient(colors: [Tokens.surface0.opacity(0.82), Tokens.surface0.opacity(0.94)]),
            startPoint: CGPoint(x: 0, y: size.height * 0.2), endPoint: CGPoint(x: size.width, y: size.height * 0.6)))
      }
      var texture = context
      texture.scaleBy(x: size.width / 1920, y: size.height / 1080)
      texture.fill(InstallationForms.stipple, with: .color(Tokens.text1.opacity(0.13)))
    }
    .accessibilityHidden(true).allowsHitTesting(false).ignoresSafeArea()
  }
}

/// Frozen at phrase entrance; actual word widths include native fallback fonts.
enum PhraseFitting {
  private final class Measurement {
    let width: CGFloat
    let height: CGFloat
    init(width: CGFloat, height: CGFloat) { self.width = width; self.height = height }
  }
  private static let measurements = NSCache<NSString, Measurement>()
  private static func measure(_ text: String, size: CGFloat) -> Measurement {
    measurements.countLimit = 512
    let key = "\(size)-\(text)" as NSString
    if let cached = measurements.object(forKey: key) { return cached }
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text,
      attributes: [NSAttributedString.Key(kCTFontAttributeName as String): Tokens.typeface(size)]))
    var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
    let width = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    let measured = Measurement(width: ceil(CGFloat(width)), height: ceil(ascent + descent + leading))
    measurements.setObject(measured, forKey: key)
    return measured
  }
  static func wordWidth(_ text: String, size: CGFloat) -> CGFloat { measure(text, size: size).width }

  /// Matches the greedy row grouping and exact gaps used by FlowLayout.
  static func height(words: [String], size: CGFloat, width: CGFloat,
                     spacing: CGFloat = 16, lineSpacing: CGFloat = 10) -> CGFloat {
    guard !words.isEmpty, width > 0 else { return 0 }
    var total: CGFloat = 0, rowWidth: CGFloat = 0, rowHeight: CGFloat = 0
    for word in words {
      let metrics = measure(word, size: size)
      let wordWidth = min(width, metrics.width)
      let nextWidth = rowWidth == 0 ? wordWidth : rowWidth + spacing + wordWidth
      if rowWidth > 0, nextWidth > width {
        total += rowHeight + lineSpacing
        rowWidth = wordWidth; rowHeight = metrics.height
      } else {
        rowWidth = nextWidth; rowHeight = max(rowHeight, metrics.height)
      }
    }
    return total + rowHeight
  }
  static func size(words: [String], width: CGFloat, height: CGFloat,
                   spacing: CGFloat = 16, lineSpacing: CGFloat = 10,
                   minSize: CGFloat = 44) -> CGFloat {
    var size: CGFloat = 108
    while size > minSize {
      if self.height(words: words, size: size, width: width,
                     spacing: spacing, lineSpacing: lineSpacing) <= height { break }
      size -= 2
    }
    return size
  }
}
