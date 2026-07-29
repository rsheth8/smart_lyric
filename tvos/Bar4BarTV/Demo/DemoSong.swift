import Foundation
import Bar4BarCore

/// The bundled demo track.
///
/// Every word below is ORIGINAL text written for this app. That is deliberate,
/// not incidental: shipping a real song's lyrics inside the binary would be a
/// copyright problem and an App Store review problem, and no licensed catalog
/// lyric may be redistributed offline. Writing our own also lets the demo be
/// *designed* — each line below exists to exercise a specific display feature
/// that would otherwise need a real subscription and a lucky song choice to see.
enum DemoSong {

  static let title = "Bar for Bar"
  static let artist = "Bar4Bar"
  static let album = "Demo Reel"

  /// Dominant "artwork" color — a deep gold, not the accent itself.
  ///
  /// It still goes through the full art-adaptive rebuild (chroma 0.099, hue
  /// 83°) rather than short-circuiting it, but lands on #E3BF77 ≈ the brand
  /// champagne gold, so the flagship screen looks like Bar4Bar. Pinned by
  /// `testDemoArtColorRebuildsToBrandGold`.
  static let artworkDominant = RGB(0x8C6A1F)

  static let duration: Double = 52.0

  /// Feature map, line by line:
  ///
  /// - 0–1   ordinary phrasing, a gold wipe at a natural pace
  /// - gap   4.6 s instrumental → ♪ indicator, then the count-in runway
  /// - 2     dense multi-syllable words → per-word lead-in scaling
  /// - 3     ordinary phrasing again, settling after the dense line
  /// - 4     a 5.2 s held note → the hold treatment, and proof the highlight
  ///         does not race ahead the way a syllable spread would
  /// - 5     a second vocalist (`agent: "v2"`) → duet staging
  /// - 6     eight short words in 3.8 s → the fast/rap case
  /// - 7     the hook returns — lines 0–1 repeated verbatim, which is what
  ///         makes the song derive as Chorus / Verse / Chorus and gives the
  ///         structure rail something true to draw
  /// - gap   4.0 s → a second instrumental beat mid-hook
  /// - 8     the hook's second line, ending on a long tail
  static func timeline() -> Timeline {
    Timeline(
      lines: [
        line(0.80, 4.60, [
          ("Drop", 0.80, 1.15), ("the", 1.15, 1.32), ("needle,", 1.32, 2.00),
          ("let", 2.20, 2.45), ("the", 2.45, 2.62), ("room", 2.62, 3.10),
          ("turn", 3.10, 3.45), ("gold", 3.45, 4.60),
        ]),
        line(5.00, 8.60, [
          ("Every", 5.00, 5.45), ("bar", 5.45, 5.95), ("lands", 5.95, 6.45),
          ("right", 6.60, 6.95), ("where", 6.95, 7.30), ("it's", 7.30, 7.55),
          ("told", 7.55, 8.60),
        ]),

        // ── 4.6 s instrumental ─────────────────────────────────────────────

        line(13.20, 17.00, [
          ("Say", 13.20, 13.55), ("it", 13.55, 13.75), ("with", 13.75, 14.00),
          ("me,", 14.00, 14.55), ("syllable", 14.85, 15.55), ("for", 15.55, 15.80),
          ("syllable", 15.80, 17.00),
        ]),
        line(17.40, 20.60, [
          ("Nothing", 17.40, 17.95), ("rushed", 17.95, 18.45), ("and", 18.45, 18.68),
          ("nothing", 18.68, 19.20), ("late", 19.20, 20.60),
        ]),

        // A genuine 5.2 s sustain. A static syllable spread would sprint through
        // this and land the next line early — the exact failure this app exists
        // to fix, so the demo shows it being handled.
        line(21.20, 27.20, [
          ("Hold", 21.20, 21.70), ("it", 21.70, 22.00), ("here", 22.00, 27.20),
        ]),

        line(27.80, 31.00, [
          ("And", 27.80, 28.05), ("I'll", 28.05, 28.35), ("take", 28.35, 28.75),
          ("the", 28.75, 28.95), ("harmony", 28.95, 31.00),
        ], agent: "v2"),

        line(31.40, 35.20, [
          ("Quick,", 31.40, 31.66), ("quick,", 31.66, 31.92), ("catch", 31.92, 32.20),
          ("it", 32.20, 32.38), ("on", 32.38, 32.58), ("the", 32.58, 32.74),
          ("up-beat", 32.74, 33.30), ("now", 33.30, 35.20),
        ]),
        // The hook returns, word for word. It has to be a genuine repeat of
        // lines 0–1 and not merely a similar sentiment: `Sections.derive` finds
        // the chorus by looking for a *repeated passage*, so without this the
        // demo could never show the structure rail — and a demo song with no
        // chorus at all is unlike any song the app will ever meet.
        line(35.80, 40.00, [
          ("Drop", 35.80, 36.15), ("the", 36.15, 36.32), ("needle,", 36.32, 37.00),
          ("let", 37.20, 37.45), ("the", 37.45, 37.62), ("room", 37.62, 38.10),
          ("turn", 38.10, 38.45), ("gold", 38.45, 40.00),
        ]),

        // ── 4.0 s instrumental ─────────────────────────────────────────────

        line(44.00, 48.50, [
          ("Every", 44.00, 44.45), ("bar", 44.45, 44.95), ("lands", 44.95, 45.45),
          ("right", 45.60, 45.95), ("where", 45.95, 46.30), ("it's", 46.30, 46.55),
          ("told", 46.55, 48.50),
        ]),
      ],
      duration: duration,
      estimated: false,
      source: "demo"
    )
  }

  private static func line(
    _ start: Double,
    _ end: Double,
    _ words: [(String, Double, Double)],
    agent: String? = nil
  ) -> LyricLine {
    LyricLine(
      start: start,
      end: end,
      words: words.map { LyricWord(text: $0.0, start: $0.1, end: $0.2) },
      agent: agent,
      uncertain: false
    )
  }
}
