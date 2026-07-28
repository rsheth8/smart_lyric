import SwiftUI
import Bar4BarCore

/// Full-bleed 10-foot karaoke surface.
///
/// Everything on screen is derived from one number — the cue time — recomputed
/// each frame. There is deliberately no implicit SwiftUI animation on the lyric
/// layer: an animation has its own idea of when a value should arrive, and a
/// karaoke highlight that eases toward the truth is, by definition, late. The
/// clock is the only authority.
struct KaraokeView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath

  /// How much runway to show around the active line.
  private let lookahead = 2
  private let lookbehind = 1

  @State private var chromeWake = Date()
  @Namespace private var emptyNamespace

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: false)) { context in
      let t = cueTime
      let lines = session.timeline.lines
      let activeLi = DisplayMath.resolveActiveLine(lines, t: t)
      let countIn = DisplayMath.countInState(lines: lines, t: t, activeLi: activeLi)
      let gap = DisplayMath.gapState(lines: lines, t: t, activeLi: activeLi)
      let chromeVisible = chromeIsAwake(now: context.date)

      ZStack {
        backdrop

        if lines.isEmpty {
          emptyState
        } else {
          lyricLadder(lines: lines, t: t, activeLi: activeLi, countIn: countIn, gap: gap)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, Tokens.safeX)

          // Floated rather than stacked above the lyrics: putting it in the
          // ladder's flow shoved every line down when a break began, and a
          // whole-screen jump on every instrumental is worse than the gap it
          // is reporting. It sits in the empty band between the chrome and the
          // first line — a scrim was tried instead and read as a hole punched
          // through the screen.
          if gap.instrumental {
            instrumentalIndicator(nextIn: gap.nextVocalIn)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
              .padding(.top, 150)
          }
        }

        if hasLyrics {
          VStack {
            topChrome
              .opacity(chromeVisible ? 1 : 0)
            Spacer()
            bottomChrome()
              .opacity(chromeVisible ? 1 : 0)
          }
          .padding(.horizontal, Tokens.safeX)
          .padding(.vertical, Tokens.safeY)
          .animation(.easeOut(duration: Tokens.Motion.slow), value: chromeVisible)
        }
      }
    }
    // Only claim focus when there is something to steer. The empty state has
    // real buttons, and a focusable backdrop competing with them means the
    // first press of the remote does nothing.
    .focusable(hasLyrics)
    .onPlayPauseCommand {
      wake()
      Task { await music.togglePlayPause() }
    }
    .onMoveCommand { direction in
      // Any direction wakes the chrome — that is how the controls are
      // discovered at all, since there is nothing else to press on this screen.
      wake()
      switch direction {
      case .left: session.nudgeSync(by: -0.05)
      case .right: session.nudgeSync(by: 0.05)
      default: break
      }
    }
  }

  private var hasLyrics: Bool { !session.timeline.lines.isEmpty }

  private var cueTime: Double {
    music.playbackTime + session.syncOffset + session.singerLead
  }

  private var accent: AccentPalette {
    session.accent
  }

  // MARK: - Chrome auto-hide

  /// Lean-back rule: chrome shows on input, then gets out of the way. 4.8 s
  /// rather than the desktop's 3.5 s — a viewer across the room needs longer.
  private func chromeIsAwake(now: Date) -> Bool {
    now.timeIntervalSince(chromeWake) < 4.8
  }

  private func wake() {
    chromeWake = Date()
  }

  // MARK: - Backdrop

  /// Espresso ground plus a slow album-art glow. The glow is what ties the
  /// screen to this particular song, so it uses the per-song accent rather
  /// than the brand gold.
  private var backdrop: some View {
    ZStack {
      Tokens.surface0

      RadialGradient(
        colors: [accent.glow.opacity(0.22), accent.glow.opacity(0.05), .clear],
        center: .init(x: 0.5, y: 0.42),
        startRadius: 0,
        endRadius: 900
      )
      .blendMode(.screen)

      // Vignette keeps the eye centered on a large panel.
      RadialGradient(
        colors: [.clear, Color.black.opacity(0.55)],
        center: .center,
        startRadius: 420,
        endRadius: 1250
      )
    }
    .ignoresSafeArea()
  }

  // MARK: - Lyric ladder

  @ViewBuilder
  private func lyricLadder(
    lines: [LyricLine],
    t: Double,
    activeLi: Int,
    countIn: DisplayMath.CountIn?,
    gap: DisplayMath.GapState
  ) -> some View {
    let lower = max(0, activeLi - lookbehind)
    let upper = min(lines.count - 1, max(activeLi, 0) + lookahead)

    VStack(spacing: Tokens.Space.s5) {
      if activeLi < 0, let countIn {
        // Before the first line the runway *is* the content.
        countInRunway(countIn)
      }

      if upper >= lower {
        ForEach(lower...upper, id: \.self) { index in
          let depth = depthFor(
            index: index,
            activeLi: activeLi,
            countIn: countIn,
            instrumental: gap.instrumental
          )
          LyricLineView(line: lines[index], t: t, depth: depth, accent: accent)
            .opacity(depth.opacity)
            .blur(radius: depth.blur)
            .scaleEffect(depth.scale)
        }
      }
    }
    .frame(maxWidth: 1600)
  }

  private func depthFor(
    index: Int,
    activeLi: Int,
    countIn: DisplayMath.CountIn?,
    instrumental: Bool
  ) -> LineDepth {
    // During a break the "active" line has already been sung. Leaving it lit
    // is the parked-highlight bug: the screen keeps pointing at a word nobody
    // is singing. Let it recede and give the runway to what's coming.
    if instrumental {
      if index <= activeLi { return .past }
      if index == activeLi + 1 { return .prep }
      return .idle
    }
    if index == activeLi { return .active }
    if index < activeLi { return .past }
    if index == activeLi + 1 {
      // "prep-ready": the count-in is already running for this line, so lift it
      // toward legibility before it becomes active.
      let prepping = countIn?.idx == index && (countIn?.progress ?? 0) > 0.35
      return prepping ? .prep : .next
    }
    return .idle
  }

  // MARK: - Count-in

  private func countInRunway(_ countIn: DisplayMath.CountIn) -> some View {
    VStack(spacing: Tokens.Space.s3) {
      Text("\(countIn.beat)")
        .font(Tokens.display(Tokens.FontSize.xxl * 1.4, .bold))
        .foregroundStyle(accent.accent)
        .monospacedDigit()

      Capsule()
        .fill(Tokens.surface2)
        .frame(width: 460, height: 8)
        .overlay(alignment: .leading) {
          Capsule()
            .fill(accent.accent)
            .frame(width: 460 * countIn.progress, height: 8)
        }
    }
  }

  // MARK: - Instrumental

  private func instrumentalIndicator(nextIn: Double?) -> some View {
    VStack(spacing: Tokens.Space.s2) {
      Text("♪")
        .font(Tokens.display(Tokens.FontSize.xxl, .semibold))
        .foregroundStyle(accent.accent)
      if let nextIn, nextIn.isFinite, nextIn > 0 {
        Text("next line in \(Int(nextIn.rounded()))s")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text3)
      }
    }
    .padding(.vertical, Tokens.Space.s3)
  }

  // MARK: - Chrome

  private var topChrome: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: Tokens.Space.s1) {
        Text(music.nowPlaying?.title ?? "No track")
          .font(Tokens.display(Tokens.FontSize.md, .semibold))
          .foregroundStyle(Tokens.text1)
        Text(music.nowPlaying?.artist ?? "")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text2)
      }
      Spacer()
      statusChip
    }
  }

  @ViewBuilder
  private var statusChip: some View {
    if session.isLoading {
      chip(label: "Fetching lyrics…", tint: Tokens.text2, dot: false)
    } else if music.isDemo {
      chip(label: "Demo", tint: accent.accent, dot: true)
    } else if let status = session.statusMessage {
      chip(label: status, tint: Tokens.text2, dot: false)
    }
  }

  private func chip(label: String, tint: Color, dot: Bool) -> some View {
    HStack(spacing: Tokens.Space.s2) {
      if dot {
        Circle().fill(tint).frame(width: 10, height: 10)
      }
      Text(label)
        .font(Tokens.display(Tokens.FontSize.sm, .semibold))
        .foregroundStyle(tint)
    }
    .padding(.horizontal, Tokens.Space.s3)
    .padding(.vertical, Tokens.Space.s2)
    .background(Tokens.surface2, in: Capsule())
    .overlay(Capsule().stroke(Tokens.line1, lineWidth: 1))
  }

  private func bottomChrome() -> some View {
    VStack(spacing: Tokens.Space.s3) {
      progressBar

      HStack(spacing: Tokens.Space.s4) {
        Image(systemName: music.isPlaying ? "pause.fill" : "play.fill")
          .font(.system(size: Tokens.FontSize.base))
          .foregroundStyle(Tokens.text1)

        Text(elapsedLabel)
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .monospacedDigit()
          .foregroundStyle(Tokens.text2)

        Spacer()

        // Nothing on this screen is pressable, so the only way anyone learns
        // that the remote does anything is to be told. The legend rides the
        // same auto-hide as the rest of the chrome, so it teaches once and
        // then gets out of the way.
        remoteHint(icon: "playpause.fill", label: "Play / pause")
        remoteHint(
          icon: "arrow.left.and.right",
          label: String(format: "Trim sync  %+.2fs", session.syncOffset),
          highlighted: session.syncOffset != 0
        )
        remoteHint(icon: "chevron.left", label: "Menu · back")
      }
    }
  }

  /// A hairline of elapsed progress. The only thing on the karaoke screen that
  /// answers "how much of this song is left".
  @ViewBuilder
  private var progressBar: some View {
    if let duration = music.nowPlaying?.duration, duration > 0 {
      let fraction = min(1, max(0, music.playbackTime / duration))
      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule().fill(Tokens.line1)
          Capsule()
            .fill(accent.accent)
            .frame(width: proxy.size.width * fraction)
        }
      }
      .frame(height: 4)
    }
  }

  private func remoteHint(icon: String, label: String, highlighted: Bool = false) -> some View {
    HStack(spacing: Tokens.Space.s2) {
      Image(systemName: icon)
        .font(.system(size: Tokens.FontSize.xs))
        .foregroundStyle(highlighted ? accent.accent : Tokens.text3)
      Text(label)
        .font(Tokens.display(Tokens.FontSize.sm, .medium))
        .monospacedDigit()
        .foregroundStyle(highlighted ? Tokens.text1 : Tokens.text2)
    }
    .padding(.horizontal, Tokens.Space.s3)
    .padding(.vertical, Tokens.Space.s2)
    .background(Tokens.surface1, in: Capsule())
    .overlay(Capsule().stroke(highlighted ? accent.accent.opacity(0.45) : Tokens.line1, lineWidth: 1))
  }

  private var elapsedLabel: String {
    guard let duration = music.nowPlaying?.duration, duration > 0 else {
      return formatTime(music.playbackTime)
    }
    return "\(formatTime(music.playbackTime)) / \(formatTime(duration))"
  }

  /// The no-lyrics screen.
  ///
  /// Previously this was one grey sentence — "Pick a song to start." — with no
  /// way to pick one, under a transport bar for a track that did not exist.
  /// Every branch here now offers the thing it is telling you to do.
  private var emptyState: some View {
    VStack(spacing: Tokens.Space.s4) {
      Image(systemName: emptyIcon)
        .font(.system(size: 78, weight: .light))
        .foregroundStyle(session.errorMessage != nil ? Tokens.ember : Tokens.accentStatic)
        .opacity(0.85)

      Text(emptyTitle)
        .font(Tokens.display(Tokens.FontSize.xl, .bold))
        .multilineTextAlignment(.center)
        .foregroundStyle(Tokens.text1)

      Text(emptyDetail)
        .font(Tokens.display(Tokens.FontSize.base, .regular))
        .multilineTextAlignment(.center)
        .foregroundStyle(Tokens.text2)
        .frame(maxWidth: 900)
        .fixedSize(horizontal: false, vertical: true)

      if !session.isLoading {
        // Without an explicit default, tvOS left this screen with nothing
        // focused: the backdrop stops being focusable when there are no
        // lyrics, and the focus engine does not adopt a pushed view's buttons
        // on its own. The first press of the remote did nothing at all.
        HStack(spacing: Tokens.Space.s3) {
          if !music.isDemo {
            Button("Play the demo") { music.startDemo() }
              .buttonStyle(TVPillStyle())
              .prefersDefaultFocus(in: emptyNamespace)
          }
          if music.authStatus == .authorized {
            Button("Find a song") { path.append(Route.search) }
              .buttonStyle(TVPillStyle())
          }
          Button("Back to hub") { path = NavigationPath() }
            .buttonStyle(TVPillStyle())
            .prefersDefaultFocus(music.isDemo, in: emptyNamespace)
        }
        .focusScope(emptyNamespace)
        .padding(.top, Tokens.Space.s2)
      }
    }
    .padding(Tokens.safeX)
  }

  private var emptyIcon: String {
    if session.errorMessage != nil { return "text.badge.xmark" }
    if session.isLoading { return "waveform" }
    return music.nowPlaying == nil ? "music.note.list" : "waveform"
  }

  private var emptyTitle: String {
    if session.errorMessage != nil { return "No synced lyrics for this one" }
    if session.isLoading { return "Fetching lyrics…" }
    return music.nowPlaying == nil ? "Nothing is playing yet" : "Waiting for lyrics…"
  }

  private var emptyDetail: String {
    if let err = session.errorMessage { return err }
    if session.isLoading { return "Looking through the catalog for word-level timing." }
    if music.nowPlaying == nil {
      return "Start the bundled demo to see word-by-word timing, or pick something from the Apple Music catalog."
    }
    return "\(music.nowPlaying?.title ?? "This track") is playing — the lyrics will appear as soon as they arrive."
  }

  private func formatTime(_ t: Double) -> String {
    let s = Int(max(0, t).rounded(.down))
    return String(format: "%d:%02d", s / 60, s % 60)
  }
}

// MARK: - Line depth

/// The depth-of-field ladder, ported from `body[data-surface="tv"] .line` in
/// styles.css. These are the TV values, not the desktop ones.
enum LineDepth {
  case past, active, next, prep, idle

  var opacity: Double {
    switch self {
    case .active: return 1
    case .next: return Tokens.DOF.nextOpacity
    case .prep: return Tokens.DOF.prepOpacity
    case .past: return Tokens.DOF.pastOpacity
    case .idle: return Tokens.DOF.idleOpacity
    }
  }

  var blur: CGFloat {
    switch self {
    case .active: return 0
    case .next: return Tokens.DOF.nextBlur
    case .prep: return Tokens.DOF.prepBlur
    case .past: return Tokens.DOF.pastBlur
    case .idle: return Tokens.DOF.idleBlur
    }
  }

  var scale: CGFloat { self == .active ? 1.0 : 0.965 }

  var fontSize: CGFloat { self == .active ? 72 : 46 }

  var isActive: Bool { self == .active }
}

// MARK: - Line

struct LyricLineView: View {
  let line: LyricLine
  let t: Double
  let depth: LineDepth
  let accent: AccentPalette

  var body: some View {
    FlowLayout(
      spacing: depth.isActive ? 20 : 14,
      lineSpacing: depth.isActive ? 12 : 8,
      alignment: horizontalAlignment
    ) {
      ForEach(Array(line.words.enumerated()), id: \.offset) { index, word in
        WordWipeView(
          word: word,
          t: t,
          depth: depth,
          accent: accent,
          gapToNext: gapToNext(after: index)
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: frameAlignment)
  }

  /// Duet staging: a second vocalist's lines sit on the opposite side, the way
  /// Apple's TTML `agent` staging reads on a shared screen.
  private var isSecondaryAgent: Bool {
    guard let agent = line.agent else { return false }
    return agent != "v1"
  }

  private var horizontalAlignment: HorizontalAlignment {
    guard line.agent != nil else { return .center }
    return isSecondaryAgent ? .trailing : .leading
  }

  private var frameAlignment: Alignment {
    guard line.agent != nil else { return .center }
    return isSecondaryAgent ? .trailing : .leading
  }

  /// Silence between this word and the next — decides whether the wipe runs
  /// out smoothly or is cut short.
  private func gapToNext(after index: Int) -> Double {
    guard index + 1 < line.words.count else { return .infinity }
    return line.words[index + 1].start - line.words[index].end
  }
}

// MARK: - Word

/// One word, with the real gradient wipe.
///
/// The previous implementation computed `wipeProgress` and then discarded it
/// (`let lit = wipe > 0.02`), turning a continuous fill into a boolean color
/// swap — the entire point of word-level timing, thrown away at the last step.
/// Here the progress drives an actual mask, so the demo's 5-second held note
/// fills visibly across its whole duration instead of blinking gold at onset.
struct WordWipeView: View {
  let word: LyricWord
  let t: Double
  let depth: LineDepth
  let accent: AccentPalette
  let gapToNext: Double

  var body: some View {
    let phase = DisplayMath.wordPhase(t: t, start: word.start, end: word.end)
    let rawWipe = DisplayMath.wipeProgress(t: t, start: word.start, end: word.end)
    let cut = DisplayMath.cutAmount(gapToNext: gapToNext)
    let wipe = DisplayMath.wipeWithCut(wipe: rawWipe, cut: cut)
    let dim = DisplayMath.confidenceDim(score: word.score)
    let attack = DisplayMath.attackAmount(t: t, start: word.start)
    let hold = DisplayMath.holdAmount(word.end - word.start)

    Text(word.text)
      .font(Tokens.display(depth.fontSize, .bold))
      .foregroundStyle(baseColor(phase: phase))
      .overlay(alignment: .leading) {
        // The lit layer, revealed left-to-right by the wipe mask.
        Text(word.text)
          .font(Tokens.display(depth.fontSize, .bold))
          .foregroundStyle(litColor(dim: dim))
          .mask(alignment: .leading) { wipeMask(wipe) }
          .shadow(
            color: glowColor(phase: phase, hold: hold),
            radius: glowRadius(phase: phase, attack: attack, hold: hold)
          )
      }
      // A short scale kick on the attack frame makes the onset feel struck
      // rather than merely switched on.
      .scaleEffect(depth.isActive ? 1 + 0.035 * attack : 1)
  }

  /// The un-sung remainder of the word.
  private func baseColor(phase: DisplayMath.WordPhase) -> Color {
    guard depth.isActive else {
      return depth == .past ? Tokens.wordDim : Tokens.wordUpcoming
    }
    return phase == .leadin ? Tokens.wordUpcoming.opacity(0.85) : Tokens.wordUpcoming
  }

  /// The filled portion. Gold while being sung, settling to ink afterwards so
  /// the accent always marks exactly one place on screen.
  private func litColor(dim: Double) -> Color {
    let lit = accent.accent.mixed(with: Tokens.wordSung, by: settleAmount())
    // Low CTC confidence softens the fill rather than hiding it — an honest
    // signal that this word's timing is a guess.
    return lit.opacity(1 - 0.35 * dim)
  }

  /// 0 while sung, ramping to 1 over 0.28 s after the word ends.
  private func settleAmount() -> Double {
    guard t > word.end else { return 0 }
    return min(1, (t - word.end) / 0.28)
  }

  private func glowColor(phase: DisplayMath.WordPhase, hold: Double) -> Color {
    guard depth.isActive, phase == .current else { return .clear }
    return accent.accent.opacity(0.30 + 0.25 * hold)
  }

  private func glowRadius(phase: DisplayMath.WordPhase, attack: Double, hold: Double) -> CGFloat {
    guard depth.isActive, phase == .current else { return 0 }
    return 14 + 16 * attack + 10 * hold
  }

  /// Soft-edged reveal. The ramp narrows as the word completes, so a finished
  /// word is solid rather than permanently feathered at its trailing edge.
  private func wipeMask(_ wipe: Double) -> some View {
    let w = min(1, max(0, wipe))
    let soft = 0.14 * (1 - w)
    let solidTo = max(0, w - soft)
    return LinearGradient(
      stops: [
        .init(color: .white, location: 0),
        .init(color: .white, location: solidTo),
        .init(color: .clear, location: max(solidTo, w)),
        .init(color: .clear, location: 1),
      ],
      startPoint: .leading,
      endPoint: .trailing
    )
  }
}

extension Color {
  /// Linear blend in sRGB. Enough for a short crossfade between two known
  /// in-gamut brand colors; not a general-purpose perceptual mix.
  func mixed(with other: Color, by amount: Double) -> Color {
    let k = min(1, max(0, amount))
    if k <= 0 { return self }
    if k >= 1 { return other }
    #if canImport(UIKit)
    let a = UIColor(self)
    let b = UIColor(other)
    var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
    var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
    a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
    b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
    let f = CGFloat(k)
    return Color(
      .sRGB,
      red: Double(ar + (br - ar) * f),
      green: Double(ag + (bg - ag) * f),
      blue: Double(ab + (bb - ab) * f),
      opacity: Double(aa + (ba - aa) * f)
    )
    #else
    return k < 0.5 ? self : other
    #endif
  }
}
