import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

enum Theme {
  static let accent = Color(red: 0.89, green: 0.76, blue: 0.48)
  static let sung = Color(red: 0.965, green: 0.94, blue: 0.894)
  static let ink = Color(red: 0.03, green: 0.028, blue: 0.04)
}

/// One motion vocabulary, so every screen moves the same way.
enum Motion {
  /// Focus, chips, toasts: quick, with a little life.
  static let snappy = Animation.snappy(duration: 0.32, extraBounce: 0.06)
  /// Lyrics rolling up, the spotlight changing.
  static let glide = Animation.smooth(duration: 0.7)
  /// Opening and closing the stage.
  static let present = Animation.spring(duration: 0.6, bounce: 0.1)
  /// Backdrop art crossfades.
  static let fade = Animation.easeInOut(duration: 0.9)
}

extension View {
  /// Frosted panel: material, a hairline edge, a soft drop shadow.
  func glass<S: InsettableShape>(_ shape: S) -> some View {
    background(.ultraThinMaterial, in: shape)
      .overlay { shape.strokeBorder(.white.opacity(0.1), lineWidth: 1) }
      .shadow(color: .black.opacity(0.25), radius: 30, y: 14)
  }
}

/// Downloaded, decoded artwork kept in memory, so revisiting a card or opening
/// the stage never flashes an empty tile.
enum ArtCache {
  private static let images = NSCache<NSString, UIImage>()
  private static let context = CIContext()

  static func cached(_ url: String?, soft: Bool = false) -> UIImage? {
    url.flatMap { images.object(forKey: key($0, soft)) }
  }

  static func load(_ url: String?, soft: Bool = false) async -> UIImage? {
    guard let url, let u = URL(string: url) else { return nil }
    if let hit = cached(url, soft: soft) { return hit }
    var image: UIImage?
    if soft {
      if let sharp = await load(url) {
        image = await Task.detached(priority: .utility) { soften(sharp) }.value
      }
    } else if let (data, _) = try? await URLSession.shared.data(from: u) {
      image = await UIImage(data: data)?.byPreparingForDisplay()
    }
    if let image { images.setObject(image, forKey: key(url, soft)) }
    return image
  }

  private static func key(_ url: String, _ soft: Bool) -> NSString {
    (soft ? url + "#soft" : url) as NSString
  }

  /// A tiny blurred, saturated copy. Stretched full screen it reads as coloured
  /// light, and moving it costs nothing (no live blur).
  private static func soften(_ image: UIImage) -> UIImage? {
    guard let cg = image.cgImage else { return nil }
    let input = CIImage(cgImage: cg)
    let scale = 96 / max(input.extent.width, 1)
    let small = input.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let blur = CIFilter.gaussianBlur()
    blur.inputImage = small.clampedToExtent()
    blur.radius = 5
    let color = CIFilter.colorControls()
    color.inputImage = blur.outputImage
    color.saturation = 1.5
    color.brightness = -0.04
    guard let out = color.outputImage, let result = context.createCGImage(out, from: small.extent) else { return nil }
    return UIImage(cgImage: result)
  }
}

struct Artwork: View {
  let url: String?
  @State private var image: UIImage?

  init(url: String?) {
    self.url = url
    _image = State(initialValue: ArtCache.cached(url))
  }

  var body: some View {
    LinearGradient(colors: [Color(white: 0.2), Color(white: 0.09)], startPoint: .topLeading, endPoint: .bottomTrailing)
      .overlay {
        if let image {
          Image(uiImage: image).resizable().scaledToFill().transition(.opacity)
        } else {
          Image(systemName: "music.note").font(.system(size: 56, weight: .light)).foregroundStyle(.white.opacity(0.2))
        }
      }
      .clipped()
      .task(id: url) {
        if let hit = ArtCache.cached(url) { image = hit; return }
        image = nil
        let loaded = await ArtCache.load(url)
        withAnimation(.easeOut(duration: 0.35)) { image = loaded }
      }
  }
}

/// The song's artwork as slow-drifting coloured light behind everything.
struct Backdrop: View {
  let url: String?
  var dim = 0.0
  @State private var image: UIImage?
  @State private var drift = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(url: String?, dim: Double = 0) {
    self.url = url
    self.dim = dim
    _image = State(initialValue: ArtCache.cached(url, soft: true))
  }

  var body: some View {
    Theme.ink
      .overlay {
        ZStack {
          if let image {
            Image(uiImage: image).resizable().scaledToFill().id(image).transition(.opacity)
          }
        }
        .scaleEffect(drift ? 1.3 : 1.12)
        .rotationEffect(.degrees(drift ? 5 : -5))
        .offset(x: drift ? -70 : 70, y: drift ? 30 : -30)
        .opacity(0.8)
      }
      .overlay {
        LinearGradient(
          colors: [.black.opacity(0.1 + dim), .black.opacity(0.5 + dim / 2), .black.opacity(0.9)],
          startPoint: .top, endPoint: .bottom
        )
      }
      .clipped()
      .ignoresSafeArea()
      .task(id: url) {
        let next = await ArtCache.load(url, soft: true)
        guard !Task.isCancelled, next != image else { return }
        withAnimation(Motion.fade) { image = next }
      }
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
      }
  }
}

struct ToastView: View {
  let text: String?

  var body: some View {
    ZStack {
      if let text {
        Text(text)
          .font(.headline)
          .padding(.horizontal, 40)
          .padding(.vertical, 20)
          .glass(Capsule())
          .id(text)
          .transition(.asymmetric(
            insertion: .move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.9)),
            removal: .opacity.combined(with: .scale(scale: 0.96))
          ))
      }
    }
    .padding(.top, 48)
    .animation(Motion.snappy, value: text)
    .allowsHitTesting(false)
  }
}
