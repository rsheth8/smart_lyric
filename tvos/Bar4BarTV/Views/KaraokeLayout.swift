import SwiftUI

/// A fixed lyric band is shared by the hidden and visible control states.
/// Revealing the deck cannot move the line someone is currently reading.
enum KaraokeLayout {
  static let canvasHeight: CGFloat = 1080
  static let chromeBottomPad: CGFloat = 48
  static let chromeTopPad: CGFloat = 48

  static func lyricTop(chromeVisible: Bool) -> CGFloat { 0 }
  static func lyricBottom(chromeVisible: Bool) -> CGFloat { 120 }
  static func lyricBandHeight(in canvas: CGFloat = canvasHeight, chromeVisible: Bool) -> CGFloat {
    max(280, canvas - lyricTop(chromeVisible: chromeVisible) - lyricBottom(chromeVisible: chromeVisible))
  }

  /// Density depends only on the content and the viewer's chosen layout.
  /// A section change never changes the size of an already-visible line.
  static func typeSize(immersive: Bool, characters: Int) -> CGFloat {
    let base: CGFloat = immersive ? 118 : 104
    if characters > 140 { return base * 0.65 }
    if characters > 85 { return base * 0.8 }
    return base
  }
}
