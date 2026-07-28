import Foundation
import CoreGraphics
import ImageIO
import Bar4BarCore
#if canImport(UIKit)
import UIKit
#endif

/// Pulls a dominant color out of album artwork so `AccentPalette` has a hue to
/// rebuild from — the tvOS counterpart of what `app/art.js` does in the browser.
enum ArtworkAccent {

  private static let cache = NSCache<NSURL, ColorBox>()

  final class ColorBox: NSObject {
    let rgb: RGB
    init(_ rgb: RGB) { self.rgb = rgb }
  }

  /// Download and sample. Returns nil on any failure — callers fall back to the
  /// brand gold rather than showing an accentless UI.
  static func dominantColor(of url: URL) async -> RGB? {
    if let hit = cache.object(forKey: url as NSURL) { return hit.rgb }

    guard let (data, _) = try? await URLSession.shared.data(from: url),
          let rgb = dominantColor(inImageData: data)
    else { return nil }

    cache.setObject(ColorBox(rgb), forKey: url as NSURL)
    return rgb
  }

  /// Downsample hard, then average the colorful pixels.
  ///
  /// A plain mean over every pixel drifts toward grey on almost any cover,
  /// which is exactly the case `AccentPalette` rejects — so pixels with little
  /// saturation are excluded and the remaining ones are weighted by how
  /// colorful they are. A genuinely monochrome cover still yields grey, which
  /// is correct: it should fall back to the brand gold.
  static func dominantColor(inImageData data: Data) -> RGB? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }

    let side = 32
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: side,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      return nil
    }

    let width = thumb.width
    let height = thumb.height
    guard width > 0, height > 0 else { return nil }

    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let ctx = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    ctx.draw(thumb, in: CGRect(x: 0, y: 0, width: width, height: height))

    var sumR = 0.0, sumG = 0.0, sumB = 0.0, weightTotal = 0.0

    for i in stride(from: 0, to: pixels.count, by: 4) {
      let r = Double(pixels[i]) / 255
      let g = Double(pixels[i + 1]) / 255
      let b = Double(pixels[i + 2]) / 255
      let a = Double(pixels[i + 3]) / 255
      guard a > 0.5 else { continue }

      let hi = max(r, max(g, b))
      let lo = min(r, min(g, b))
      let sat = hi <= 0 ? 0 : (hi - lo) / hi

      // Skip near-grey and near-black pixels; they carry no usable hue and
      // most covers are mostly one or the other.
      guard sat > 0.18, hi > 0.12 else { continue }

      let weight = sat * hi
      sumR += r * weight
      sumG += g * weight
      sumB += b * weight
      weightTotal += weight
    }

    guard weightTotal > 0 else { return nil }
    return RGB(r: sumR / weightTotal, g: sumG / weightTotal, b: sumB / weightTotal)
  }
}
