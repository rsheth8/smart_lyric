import Foundation

/// Pure karaoke display math — port of exports in `app/display.js`.
public enum DisplayMath {
  public static let leadInWord = 0.32
  public static let firstWordLeadScale = 0.45
  public static let leadInLine = 3.0
  public static let breathGap = 0.9
  public static let countInGap = 1.2
  public static let singerLead = 0.12
  /// Listen mode: highlight the word as it is sung, with no karaoke anticipation.
  public static let singerLeadListen = 0.0
  public static let attackWindow = 0.055
  public static let lowConfScore = 0.35
  public static let singerLeadMin = 0.0
  public static let singerLeadMax = 0.25

  public static func wipeProgress(t: Double, start: Double, end: Double) -> Double {
    let dur = end - start
    if !(dur > 0) { return t >= end ? 1 : 0 }
    return min(1, max(0, (t - start) / dur))
  }

  public enum WordPhase: String, Equatable, Sendable {
    case upcoming, leadin, current, sung
  }

  public static func wordPhase(
    t: Double,
    start: Double,
    end: Double,
    leadin: Double = leadInWord
  ) -> WordPhase {
    if t >= end { return .sung }
    if t >= start { return .current }
    if t >= start - leadin { return .leadin }
    return .upcoming
  }

  public static func holdAmount(_ dur: Double) -> Double {
    min(1, max(0, (dur - 0.25) / 0.9))
  }

  public static func attackAmount(
    t: Double,
    start: Double,
    window: Double = attackWindow
  ) -> Double {
    if !(window > 0) || t < start { return 0 }
    let u = (t - start) / window
    if u >= 1 { return 0 }
    return 1 - u
  }

  public static func cutAmount(gapToNext: Double) -> Double {
    if !gapToNext.isFinite || gapToNext > 0.35 { return 0 }
    if gapToNext < 0 { return 1 }
    return min(1, max(0, (0.35 - gapToNext) / 0.35))
  }

  public static func wipeWithCut(wipe: Double, cut: Double) -> Double {
    let w = min(1, max(0, wipe))
    let c = min(1, max(0, cut))
    if c <= 0 { return w }
    return pow(w, 1 - 0.45 * c)
  }

  public static func wordLeadIn(text: String, start: Double, end: Double, base: Double = leadInWord) -> Double {
    let syll = max(1, Estimate.syllableCount(text))
    let dur = max(0, end - start)
    var lead = base
    if syll >= 3 { lead += 0.12 }
    else if syll >= 2 { lead += 0.06 }
    if dur >= 0.7 { lead += 0.08 }
    return min(0.55, lead)
  }

  public static func confidenceDim(score: Double?, floor: Double = lowConfScore) -> Double {
    guard let score, score.isFinite else { return 0 }
    if score >= floor { return 0 }
    if score <= 0 { return 1 }
    return min(1, max(0, 1 - score / floor))
  }

  public static func countInWindowForGap(_ gapSec: Double) -> Double {
    guard gapSec.isFinite, gapSec > 0 else { return 5.0 }
    if gapSec >= 10 { return 5.5 }
    if gapSec >= 6 { return 4.5 }
    if gapSec >= 3.5 { return 3.8 }
    return leadInLine
  }

  /// Fill amount for the pre-vocal runway bar, or `nil` when nothing should show.
  ///
  /// Spans the real wait (`previous line end` → `next line start`) so a short
  /// intro starts empty instead of appearing already three-quarters full, and
  /// a long instrumental is one continuous fill — not a ♪ that later jumps
  /// to a 3-2-1 overlay.
  public static func runwayProgress(
    lines: [LyricLine],
    t: Double,
    activeLi: Int,
    instrumental: Bool,
    countIn: CountIn?
  ) -> Double? {
    let nextIdx = activeLi < 0 ? 0 : activeLi + 1
    guard nextIdx < lines.count, t.isFinite else { return nil }
    let nextStart = lines[nextIdx].start
    let prevEnd = activeLi >= 0 ? lines[activeLi].end : 0
    guard t < nextStart, t >= prevEnd else { return nil }
    let waitingForFirstLine = activeLi < 0
    guard waitingForFirstLine || instrumental || countIn != nil else { return nil }
    let span = max(0.001, nextStart - prevEnd)
    return min(1, max(0, (t - prevEnd) / span))
  }

  public static func resolveActiveLine(
    _ lines: [LyricLine],
    t: Double,
    prevLi: Int = -1,
    vocalActive: Bool = true
  ) -> Int {
    guard !lines.isEmpty, t.isFinite else { return -1 }
    var catalogLi = -1
    for i in 0..<lines.count {
      if t >= lines[i].start { catalogLi = i }
      else { break }
    }
    if catalogLi <= prevLi { return catalogLi }
    if !vocalActive, prevLi >= 0 { return prevLi }
    return catalogLi
  }

  public struct CountIn: Equatable, Sendable {
    public var idx: Int
    public var until: Double
    public var progress: Double
    public var beat: Int
    public var window: Double
    public var gap: Double
  }

  public static func countInState(
    lines: [LyricLine],
    t: Double,
    activeLi: Int,
    window windowOpt: Double? = nil,
    minGap: Double = countInGap
  ) -> CountIn? {
    let idx = activeLi < 0 ? 0 : activeLi + 1
    guard !lines.isEmpty, idx < lines.count else { return nil }
    let line = lines[idx]
    let until = line.start - t
    guard until > 0 else { return nil }
    if activeLi >= 0, t < lines[activeLi].end - 0.12 { return nil }
    let prevEnd = idx > 0 ? lines[idx - 1].end : 0
    let gap = line.start - prevEnd
    if idx > 0, gap < minGap { return nil }
    let window = windowOpt ?? countInWindowForGap(idx == 0 ? line.start : gap)
    if until > window { return nil }
    return CountIn(
      idx: idx,
      until: until,
      progress: 1 - until / window,
      beat: max(1, Int(ceil(min(until, 3)))),
      window: window,
      gap: gap
    )
  }

  /// Instrumental-break detection.
  ///
  /// The web app infers this from vocal-stem energy and needs hysteresis
  /// (`instrumentalState`) because that signal is noisy — a breath between
  /// phrases would otherwise flicker the ♪ on and off. Here the timeline is
  /// exact catalog timing, so a deterministic window is both correct and
  /// simpler; there is no noise to debounce.
  public struct GapState: Equatable, Sendable {
    public var instrumental: Bool
    /// Seconds until the next sung word, or nil when the song is over.
    public var nextVocalIn: Double?

    public init(instrumental: Bool, nextVocalIn: Double?) {
      self.instrumental = instrumental
      self.nextVocalIn = nextVocalIn
    }
  }

  /// Sustained quiet before the ♪ appears — short gaps are never announced.
  public static let instrumentalEnter = 0.9
  /// A gap shorter than this is just phrasing, not an instrumental break.
  public static let instrumentalMinGap = 2.5
  /// Clear the ♪ *before* the vocal returns, so it is never in the way.
  public static let instrumentalExitLead = 0.5

  public static func gapState(
    lines: [LyricLine],
    t: Double,
    activeLi: Int,
    minGap: Double = instrumentalMinGap,
    enterAfter: Double = instrumentalEnter,
    exitLead: Double = instrumentalExitLead
  ) -> GapState {
    guard !lines.isEmpty, t.isFinite else {
      return GapState(instrumental: false, nextVocalIn: nil)
    }
    let nextIdx = activeLi + 1
    guard nextIdx < lines.count else {
      // Past the final line. The outro is an instrumental passage like any
      // other, and saying otherwise leaves the last line lit as the hero for
      // the rest of the track — the parked-highlight bug at the one moment it
      // lasts longest, since nothing ever comes along to replace it.
      guard activeLi >= 0 else { return GapState(instrumental: false, nextVocalIn: nil) }
      return GapState(
        instrumental: t >= lines[activeLi].end + enterAfter,
        nextVocalIn: nil
      )
    }

    let nextStart = lines[nextIdx].start
    let prevEnd = activeLi >= 0 ? lines[activeLi].end : 0
    let nextVocalIn = max(0, nextStart - t)

    // Still inside the current line's own span — not a gap at all.
    if activeLi >= 0, t < lines[activeLi].end {
      return GapState(instrumental: false, nextVocalIn: nextVocalIn)
    }

    let gap = nextStart - prevEnd
    guard gap >= minGap else {
      return GapState(instrumental: false, nextVocalIn: nextVocalIn)
    }

    let instrumental = t >= prevEnd + enterAfter && t < nextStart - exitLead
    return GapState(instrumental: instrumental, nextVocalIn: nextVocalIn)
  }

  public static func clampSingerLead(_ sec: Double) -> Double {
    let n = (sec * 1000).rounded() / 1000
    guard n.isFinite else { return singerLead }
    return min(singerLeadMax, max(singerLeadMin, n))
  }

  public static func inBreathGap(
    lines: [LyricLine],
    t: Double,
    lineIdx: Int,
    minGap: Double = breathGap
  ) -> Bool {
    guard !lines.isEmpty, lineIdx > 0, lineIdx < lines.count else { return false }
    let line = lines[lineIdx]
    let prev = lines[lineIdx - 1]
    let gap = line.start - prev.end
    if gap < minGap { return false }
    return t >= prev.end && t < line.start
  }
}

/// How the clock treats the singer. Sing cues the wipe early so a person can
/// start on the beat. Listen lights the word with the recording — Music's job.
public enum PerformanceMode: String, Equatable, Sendable {
  case sing
  case listen

  public var label: String {
    switch self {
    case .sing: return "Sing"
    case .listen: return "Listen"
    }
  }

  public var lead: Double {
    switch self {
    case .sing: return DisplayMath.singerLead
    case .listen: return DisplayMath.singerLeadListen
    }
  }

  /// Word lead-in used for the upcoming/arm colour. Sing arms the word;
  /// Listen does not preview it before the vocal.
  public var wordLeadIn: Double {
    switch self {
    case .sing: return DisplayMath.leadInWord
    case .listen: return 0
    }
  }

  public var toggled: PerformanceMode {
    self == .sing ? .listen : .sing
  }

  /// Anything more than a breath of lead is Sing, including a custom stepper.
  public static func from(lead: Double) -> PerformanceMode {
    lead <= 0.05 ? .listen : .sing
  }
}
