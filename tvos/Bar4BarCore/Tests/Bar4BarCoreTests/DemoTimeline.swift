import Foundation
@testable import Bar4BarCore

/// The bundled demo lives in the tvOS app target. Tests rebuild the same
/// timings here so Core can assert looks without importing the app.
enum DemoTimeline {
  static func barForBar() -> Timeline {
    func L(
      _ start: Double,
      _ end: Double,
      _ words: [(String, Double, Double)],
      agent: String? = nil
    ) -> LyricLine {
      LyricLine(
        start: start,
        end: end,
        words: words.map { LyricWord(text: $0.0, start: $0.1, end: $0.2) },
        agent: agent
      )
    }
    return Timeline(
      lines: [
        L(0.80, 4.60, [
          ("Drop", 0.80, 1.15), ("the", 1.15, 1.32), ("needle,", 1.32, 2.00),
          ("let", 2.20, 2.45), ("the", 2.45, 2.62), ("room", 2.62, 3.10),
          ("turn", 3.10, 3.45), ("gold", 3.45, 4.60),
        ]),
        L(5.00, 8.60, [
          ("Every", 5.00, 5.45), ("bar", 5.45, 5.95), ("lands", 5.95, 6.45),
          ("right", 6.60, 6.95), ("where", 6.95, 7.30), ("it's", 7.30, 7.55),
          ("told", 7.55, 8.60),
        ]),
        L(13.20, 17.00, [
          ("Say", 13.20, 13.55), ("it", 13.55, 13.75), ("with", 13.75, 14.00),
          ("me,", 14.00, 14.55), ("syllable", 14.85, 15.55), ("for", 15.55, 15.80),
          ("syllable", 15.80, 17.00),
        ]),
        L(17.40, 20.60, [
          ("Nothing", 17.40, 17.95), ("rushed", 17.95, 18.45), ("and", 18.45, 18.68),
          ("nothing", 18.68, 19.20), ("late", 19.20, 20.60),
        ]),
        L(21.20, 27.20, [
          ("Hold", 21.20, 21.70), ("it", 21.70, 22.00), ("here", 22.00, 27.20),
        ]),
        L(27.80, 31.00, [
          ("And", 27.80, 28.05), ("I'll", 28.05, 28.35), ("take", 28.35, 28.75),
          ("the", 28.75, 28.95), ("harmony", 28.95, 31.00),
        ], agent: "v2"),
        L(31.40, 35.20, [
          ("Quick,", 31.40, 31.66), ("quick,", 31.66, 31.92), ("catch", 31.92, 32.20),
          ("it", 32.20, 32.38), ("on", 32.38, 32.58), ("the", 32.58, 32.74),
          ("up-beat", 32.74, 33.30), ("now", 33.30, 35.20),
        ]),
        L(35.80, 40.00, [
          ("Drop", 35.80, 36.15), ("the", 36.15, 36.32), ("needle,", 36.32, 37.00),
          ("let", 37.20, 37.45), ("the", 37.45, 37.62), ("room", 37.62, 38.10),
          ("turn", 38.10, 38.45), ("gold", 38.45, 40.00),
        ]),
        L(44.00, 48.50, [
          ("Every", 44.00, 44.45), ("bar", 44.45, 44.95), ("lands", 44.95, 45.45),
          ("right", 45.60, 45.95), ("where", 45.95, 46.30), ("it's", 46.30, 46.55),
          ("told", 46.55, 48.50),
        ]),
      ],
      duration: 52.0,
      estimated: false,
      source: "demo"
    )
  }
}
