import SwiftUI
import UIKit
import Bar4BarCore

/// A stable performance canvas with a separate, remote-driven control deck.
struct KaraokeView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath
  private let immersive = true
  @State private var controlsVisible = !DemoLaunch.cleanStage
  @State private var menuHidCount = 0
  @AppStorage("bar4bar.stage.setupSeen") private var stageSetupSeen = false
  @State private var stagePresented = false
  @State private var timingPresented = false
  @State private var optionsPresented = false
  @State private var hideTask: Task<Void, Never>?
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || DemoLaunch.reduceMotion }
  @Environment(\.resetFocus) private var resetFocus
  @Namespace private var stageNamespace
  private enum Focus: Hashable { case stage, home, previous, back, play, forward, next, timing, view, more, hide, cheer }
  @FocusState private var focus: Focus?

  private var hasLyrics: Bool { !session.timeline.lines.isEmpty }
  private var defaultControl: Focus { music.canTransport ? .play : .timing }

  var body: some View {
    ZStack {
      Tokens.surface0
      if hasLyrics {
        performance
        if !controlsVisible { stageCatcher }
      } else {
        emptyState
      }
      if music.nowPlaying != nil && controlsVisible {
        controls
          .transition(.opacity)
          .zIndex(2)
      }
    }
    .focusScope(stageNamespace)
    .task(id: controlsVisible) {
      try? await Task.sleep(for: .milliseconds(100))
      guard !Task.isCancelled, !stagePresented else { return }
      focus = controlsVisible ? defaultControl : (hasLyrics ? .stage : nil)
      resetFocus(in: stageNamespace)
    }
    .onAppear {
      if !stageSetupSeen && ProcessInfo.processInfo.environment["BAR4BAR_SKIP_STAGE_SETUP"] != "1" { stagePresented = true }
      scheduleHide()
    }
    .onDisappear { hideTask?.cancel() }
    .onChange(of: focus) { _, _ in scheduleHide() }
    .onChange(of: hasLyrics) { _, _ in scheduleHide() }
    .onChange(of: music.isPlaying) { _, _ in scheduleHide() }
    .onPlayPauseCommand {
      showControls()
      if music.canTransport { Task { await music.togglePlayPause() } }
    }
    .onExitCommand {
      if controlsVisible {
        hideControls()
        menuHidCount += 1
      } else if menuHidCount > 0 {
        menuHidCount = 0
        path = NavigationPath()
      } else {
        showControls()
      }
    }
    .sheet(isPresented: $stagePresented, onDismiss: { stageSetupSeen = true; recover(.view) }) {
      StageSettingsPanel().environmentObject(session).environmentObject(music)
    }
    .sheet(isPresented: $timingPresented, onDismiss: { recover(.timing) }) {
      LyricsTimingPanel().environmentObject(session)
    }
    .sheet(isPresented: $optionsPresented, onDismiss: { recover(.more) }) {
      RoomOptionsPanel()
        .environmentObject(session)
        .environmentObject(music)
    }
    .navigationBarBackButtonHidden(true)
    .toolbar(.hidden, for: .navigationBar)
    .ignoresSafeArea()
  }

  private var performance: some View {
    GeometryReader { geo in
      PhraseStage()
        .id(session.lyricRevision)
        .frame(width: geo.size.width, height: geo.size.height)
        .overlay {
          // Hidden accessibility element for VoiceOver + UITests (WP-6)
          if session.partyMode == "Take turns" {
            Color.clear
              .accessibilityElement(children: .ignore)
              .accessibilityLabel(singerHandoffLabel)
              .accessibilityIdentifier("singerHandoff")
          }
        }
    }
    .allowsHitTesting(false)
  }

  private var singerHandoffLabel: String { "SIDE B takes this line" }

  private func songIdentity(side: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 24) {
      Group {
        if music.isDemo { RoomSleeve(side: side) }
        else { CoverArt(url: music.nowPlaying?.artworkURL, side: side, corner: 12) }
      }
      .shadow(color: .black.opacity(0.4), radius: 28, y: 18)
      VStack(alignment: .leading, spacing: 10) {
        Text(music.nowPlaying?.title ?? "")
          .font(Tokens.display(38, .semibold))
          .tracking(-1)
          .foregroundStyle(Tokens.text1)
          .lineLimit(2)
          .minimumScaleFactor(0.75)
        Text(music.nowPlaying?.artist ?? "")
          .font(Tokens.display(25, .regular))
          .foregroundStyle(Tokens.text2)
          .lineLimit(2)
        HStack(spacing: 8) {
          Circle().fill(session.accent.accent).frame(width: 6, height: 6)
          Text(music.isDemo ? "VISUAL DEMO" : (session.timeline.hasWordTiming ? "WORD SYNC" : "LINE SYNC"))
            .tracking(2.4)
        }
        .font(Tokens.display(16, .semibold))
        .foregroundStyle(session.accent.soft)
        .padding(.top, 12)
        if let next = session.nextPrepTitle {
          Text("Up next  ·  \(next)")
            .font(Tokens.display(19, .regular))
            .foregroundStyle(Tokens.text2)
            .lineLimit(1)
            .padding(.top, 6)
        }
      }
    }
  }

  private var stageCatcher: some View {
    Button { showControls() } label: {
      Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
    }
    .buttonStyle(StageCatcherStyle())
    .focused($focus, equals: .stage)
    .focusEffectDisabled()
    .prefersDefaultFocus(true, in: stageNamespace)
    .defaultFocus($focus, .stage, priority: .userInitiated)
    .onMoveCommand { direction in
      switch direction {
      case .left: if music.canTransport { replayCurrentLine() }
      case .right: if music.canTransport { skipToNextChorus() }
      default: showControls()
      }
    }
    .accessibilityLabel("Show playback controls")
    .accessibilityIdentifier("showPlaybackControls")
  }

  private var controls: some View {
    VStack {
      HStack(spacing: 28) {
        Button { path = NavigationPath() } label: { Label("Home", systemImage: "chevron.left") }
          .buttonStyle(RoomButtonStyle())
          .focused($focus, equals: .home)
        if immersive || !hasLyrics {
          VStack(alignment: .leading, spacing: 4) {
            Text(music.nowPlaying?.title ?? "").font(Tokens.display(26, .semibold))
            Text(music.nowPlaying?.artist ?? "").font(Tokens.display(21, .regular)).foregroundStyle(Tokens.text2)
          }.lineLimit(1)
        }
        Spacer()
        if let message = music.actionHint ?? session.aidMessage {
          Text(message).font(Tokens.display(22, .medium)).foregroundStyle(Tokens.text2).lineLimit(2)
        } else {
          Text(music.isDemo ? "52-second visual demo" : (music.isFollowing ? "Following your music" : "Now playing"))
            .font(Tokens.display(21, .medium)).foregroundStyle(Tokens.text2)
        }
      }
      Spacer()
      VStack(spacing: 22) {
        progressRail
        HStack(spacing: 16) {
          if music.canTransport { transport }
          Spacer(minLength: 28)
          action("Timing", icon: "metronome", target: .timing, id: "Lyrics timing") {
            hideTask?.cancel()
            timingPresented = true
          }
          action("Stage", icon: "sparkles", target: .view, id: "stageView") {
            hideTask?.cancel()
            stagePresented = true
          }
          action("More", icon: "ellipsis", target: .more, id: "moreOptions") {
            hideTask?.cancel()
            optionsPresented = true
          }
          action("Hide", icon: "chevron.down", target: .hide, id: "Hide controls") { hideControls() }
          action("Cheer", icon: "hands.clap", target: .cheer, id: "stageCheer") { session.cheer() }
        }
        .focusSection()
        HStack {
          Text(transportHint)
          Spacer()
          Text("Swipe up to return to the music")
        }
        .font(Tokens.display(18, .regular))
        .foregroundStyle(Tokens.text2)
        .frame(height: 24)
        .accessibilityHidden(true)
      }
      .padding(28)
      .background(Tokens.surfaceSolid1.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.1), lineWidth: 1))
    }
    .padding(.horizontal, Tokens.safeX)
    .padding(.top, 48)
    .padding(.bottom, 48)
    .defaultFocus($focus, defaultControl, priority: .userInitiated)
  }

  private func action(_ title: String, icon: String, target: Focus, id: String, perform: @escaping () -> Void) -> some View {
    Button { scheduleHide(); perform() } label: { Label(title, systemImage: icon) }
      .buttonStyle(RoomButtonStyle())
      .focused($focus, equals: target)
      .accessibilityIdentifier(id)
      .onMoveCommand { direction in
        if direction == .up { hideControls() }
        let row: [Focus] = [.timing, .view, .more, .hide, .cheer]
        if let index = row.firstIndex(of: target) {
          if direction == .right, index + 1 < row.count { focus = row[index + 1] }
          if direction == .left {
            focus = index > 0 ? row[index - 1] : (music.canTransport ? (music.canSkipTracks ? .next : .forward) : .timing)
          }
        }
      }
  }

  @ViewBuilder private var transport: some View {
    if music.canSkipTracks {
      transportButton("Previous", icon: "backward.end.fill", target: .previous) { Task { await music.skipPrevious() } }
    }
    transportButton("Skip back 15 seconds", icon: "gobackward.15", target: .back) { music.seekBy(-PlaybackSkip.nudge) }
    transportButton(music.isPlaying ? "Pause" : "Play", icon: music.isPlaying ? "pause.fill" : "play.fill", target: .play) {
      Task { await music.togglePlayPause() }
    }
    transportButton("Skip forward 15 seconds", icon: "goforward.15", target: .forward) { music.seekBy(PlaybackSkip.nudge) }
    if music.canSkipTracks {
      transportButton("Next", icon: "forward.end.fill", target: .next) { Task { await music.skipNext() } }
    }
  }

  private func transportButton(_ title: String, icon: String, target: Focus, perform: @escaping () -> Void) -> some View {
    Button { scheduleHide(); perform() } label: { Image(systemName: icon) }
      .buttonStyle(TVTransportStyle(diameter: target == .play ? 72 : 60, prominent: target == .play))
      .focused($focus, equals: target)
      .accessibilityLabel(title)
      .accessibilityIdentifier(target == .play ? "transportPlayPause" : title)
      .onMoveCommand { direction in
        if direction == .up { hideControls() }
        if direction == .down { focus = .timing }
        let row: [Focus] = music.canSkipTracks ? [.previous, .back, .play, .forward, .next, .timing] : [.back, .play, .forward, .timing]
        if let index = row.firstIndex(of: target) {
          if direction == .right, index + 1 < row.count { focus = row[index + 1] }
          if direction == .left, index > 0 { focus = row[index - 1] }
        }
      }
  }

  private var transportHint: String {
    switch focus {
    case .previous: return "Previous song"
    case .back: return "Back 15 seconds"
    case .play: return music.isPlaying ? "Pause" : "Play"
    case .forward: return "Forward 15 seconds"
    case .next: return "Next song"
    case .timing: return "Match the words to what you hear"
    case .view: return "Choose your show, preview and singer roles"
    case .more: return "Language, sing mode and playback options"
    case .cheer: return "Give the room a cheer"
    default: return music.canTransport ? "" : "Control playback in your music app"
    }
  }

  private var progressRail: some View {
    let duration = music.nowPlaying?.duration ?? session.timeline.duration
    let fraction = duration > 0 ? min(1, max(0, music.liveTime / duration)) : 0
    return HStack(spacing: 18) {
      Text(timeLabel(music.liveTime)).frame(width: 56, alignment: .leading)
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(.white.opacity(0.14))
          Capsule().fill(session.accent.accent).frame(width: max(0, geo.size.width * fraction))
          Circle().fill(Tokens.text1).frame(width: 8, height: 8).offset(x: geo.size.width * fraction - 4)
        }.frame(height: 3).frame(maxHeight: .infinity)
      }.frame(height: 10)
      Text("−" + timeLabel(max(0, duration - music.liveTime))).frame(width: 66, alignment: .trailing)
    }
    .font(Tokens.display(19, .medium)).monospacedDigit().foregroundStyle(Tokens.text2)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Song position")
    .accessibilityValue("\(timeLabel(music.liveTime)) of \(timeLabel(duration))")
  }

  private func timeLabel(_ time: Double) -> String {
    let value = max(0, Int(time.isFinite ? time : 0))
    return String(format: "%d:%02d", value / 60, value % 60)
  }

  private func showControls() {
    menuHidCount = 0
    guard !controlsVisible else { scheduleHide(); return }
    focus = nil
    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { controlsVisible = true }
    scheduleHide()
  }
  private func hideControls() {
    guard hasLyrics else { return }
    hideTask?.cancel()
    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { controlsVisible = false }
  }
  private func recover(_ target: Focus) {
    focus = target
    scheduleHide()
  }
  private func scheduleHide() {
    hideTask?.cancel()
    guard controlsVisible, hasLyrics, music.isPlaying, !timingPresented, !optionsPresented, !stagePresented else { return }
    hideTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(8))
      guard !Task.isCancelled, !timingPresented, !optionsPresented, !stagePresented else { return }
      hideControls()
    }
  }

  private func replayCurrentLine() {
    let lines = session.timeline.lines
    let cue = music.liveTime + session.totalAlignment + session.singerLead
    let activeLi = DisplayMath.resolveActiveLine(lines, t: cue)
    if let start = StageDirection.currentLineStart(lines: lines, t: cue, activeLi: activeLi) {
      music.seek(to: max(0, start - session.totalAlignment - session.singerLead))
    }
  }

  private func skipToNextChorus() {
    let cue = music.liveTime + session.totalAlignment + session.singerLead
    if let start = StageDirection.nextChorusStart(sections: session.sections, t: cue) {
      music.seek(to: max(0, start - session.totalAlignment - session.singerLead))
    }
  }

  private var emptyState: some View {
    VStack(spacing: 28) {
      if session.isLoading { ProgressView().tint(Tokens.accentStatic).scaleEffect(1.5) }
      else { Image(systemName: "text.quote").font(.system(size: 64)).foregroundStyle(Tokens.accentStatic) }
      Text(session.isLoading ? "Finding the words…" : (music.nowPlaying == nil ? "Let’s put a song on." : "No synced lyrics for this one."))
        .font(Tokens.display(48, .semibold))
      Text(session.isLoading ? "Your music keeps playing while we look." : (session.errorMessage ?? "Choose a song, or explore the visual demo."))
        .font(Tokens.display(26, .regular)).foregroundStyle(Tokens.text2)
        .multilineTextAlignment(.center).frame(maxWidth: 1000)
      if !session.isLoading {
        HStack(spacing: 20) {
          if let track = music.nowPlaying, !track.isDemo {
            Button("Try again") { Task { await session.load(for: track) } }.buttonStyle(RoomButtonStyle())
          }
          Button("Play the demo") { music.startDemo() }.buttonStyle(RoomButtonStyle(prominent: true))
          Button("Find a song") { path.append(Route.search) }.buttonStyle(RoomButtonStyle())
        }
      }
    }
    .padding(.bottom, music.nowPlaying != nil ? 180 : 0)
    .foregroundStyle(Tokens.text1)
  }
}

private struct RoomOptionsPanel: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Environment(\.dismiss) private var dismiss
  @FocusState private var firstFocused: Bool

  var body: some View {
    ZStack {
      PosterEnvironment(letters: "MY", browsing: true)
      VStack(alignment: .leading, spacing: 28) {
        HStack {
          VStack(alignment: .leading, spacing: 8) {
            Text("Make it yours.").font(Tokens.editorial(48, italic: true)).tracking(-1.5)
            Text("A few ways to enjoy this song.").font(Tokens.display(25, .regular)).foregroundStyle(Tokens.text2)
          }
          Spacer()
          Button("Done") { dismiss() }.buttonStyle(RoomButtonStyle())
        }
        TVGroup(title: "The words") {
          TVActionRow(title: "Language aid", subtitle: session.aidMessage ?? session.aidMode.label, icon: "textformat") {
            Task { await session.cycleAid() }
          }
          .focused($firstFocused)
          .accessibilityIdentifier("languageAid")
          .accessibilityValue(session.aidMode.label)
          TVActionRow(title: session.performanceMode == .sing ? "Sing along" : "Listen", subtitle: session.performanceMode == .sing ? "Words light a little early, so you can join in" : "Words light with the recording", icon: session.performanceMode == .sing ? "mic" : "headphones") {
            session.togglePerformanceMode()
          }
          .accessibilityIdentifier("performanceMode")
        }
        if music.canTransport {
          TVGroup(title: "One more time") {
            TVActionRow(title: "This line again", subtitle: "Jump to the start of the current line", icon: "arrow.uturn.backward") { replayLine() }
              .accessibilityIdentifier("againLine")
            if StageDirection.nextChorusStart(sections: session.sections, t: cueTime) != nil {
              TVActionRow(title: "Skip to chorus", icon: "music.note.list") { skipChorus() }
                .accessibilityIdentifier("skipChorus")
            }
          }
        }
        if music.canControlQueue {
          HStack(spacing: 18) {
            Button(music.isLoved ? "Loved" : "Love") { Task { await music.toggleLove() } }
              .disabled(!music.canLove || music.isLoving)
            Button(music.isInLibrary ? "In library" : "Add to library") { Task { await music.addCurrentToLibrary() } }
              .disabled(!music.canAddToLibrary || music.isInLibrary || music.isAddingToLibrary)
            Button(music.shuffleEnabled ? "Shuffle on" : "Shuffle off") { music.toggleShuffle() }
            Button(music.repeatCycle.label) { music.cycleRepeat() }
          }.buttonStyle(RoomButtonStyle())
          if let hint = music.actionHint {
            Text(hint).font(Tokens.display(21, .medium)).foregroundStyle(Tokens.accentSoft)
          }
        }
      }
      .frame(maxWidth: 1180)
      .padding(64)
    }
    .task {
      try? await Task.sleep(for: .milliseconds(160))
      firstFocused = true
    }
    .onExitCommand { dismiss() }
  }
  private var cueTime: Double { music.liveTime + session.totalAlignment + session.singerLead }
  private func seek(_ cue: Double) {
    music.seek(to: max(0, cue - session.totalAlignment - session.singerLead))
    dismiss()
  }
  private func replayLine() {
    let lines = session.timeline.lines
    let active = DisplayMath.resolveActiveLine(lines, t: cueTime)
    if let start = StageDirection.currentLineStart(lines: lines, t: cueTime, activeLi: active) { seek(start) }
  }
  private func skipChorus() {
    if let start = StageDirection.nextChorusStart(sections: session.sections, t: cueTime) { seek(start) }
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

  var scale: CGFloat { self == .active ? 1.0 : 0.82 }

  var isActive: Bool { self == .active }
}

extension StageLook {
  /// Type size for this camera. Document keeps the established 84pt ladder;
  /// Anthem is a close-up that still wraps inside the field; Picture is a
  /// ghost; Breath is a held silhouette.
  var lyricSize: CGFloat {
    switch self {
    case .document: return 84
    case .anthem: return 100
    case .picture: return 52
    case .breath: return 96
    }
  }
}

// MARK: - Render mode

/// Controls how `WordWipeView` renders each glyph.
/// - `.wipe`: existing L-R mask wipe (default, unchanged).
/// - `.filament`: whole-glyph heat — opacity ramps with `wipeProgress`, no mask.
enum WordRenderMode { case wipe, filament }

// MARK: - Line

struct LyricLineView: View {
  let line: LyricLine
  let t: Double
  let depth: LineDepth
  let accent: AccentPalette
  var wordTiming: Bool = true
  var aidText: String? = nil
  var aidMode: LanguageAidMode = .off
  var look: StageLook = .document
  var dense: Bool = false
  var finale: Bool = false
  var listen: Bool = false
  var typeSize: CGFloat? = nil
  var leading: Bool = false
  var emphasisWord: Int? = nil
  var emphasisAmount: Double = 0
  var heldWord: Int? = nil
  var expressiveScale = false
  var estimatedWords: Set<Int> = []
  var renderMode: WordRenderMode = .wipe

  var body: some View {
    VStack(spacing: aidText == nil ? 0 : 8) {
      if let slug = StageDirection.lane(for: line).slug {
        Text(slug)
          .font(Tokens.display(22, .semibold))
          .tracking(4)
          .foregroundStyle(fill.opacity(depth.isActive ? 0.72 : 0.32))
      }
      if wordTiming {
        FlowLayout(
          spacing: dense ? 10 : (look == .anthem ? 22 : 16),
          lineSpacing: dense ? 6 : (look == .anthem ? 14 : 10),
          alignment: horizontalAlignment,
          balanced: leading
        ) {
          ForEach(Array(line.words.enumerated()), id: \.offset) { index, word in
            if depth.isActive {
              WordWipeView(
                word: word, t: t, depth: depth,
                gapToNext: gapToNext(after: index),
                typeSize: resolvedTypeSize, fill: fill,
                listen: listen,
                estimated: estimatedWords.contains(index),
                emphasis: emphasisWord == index ? emphasisAmount : 0,
                held: heldWord == index,
                expressiveScale: expressiveScale,
                renderMode: renderMode
              )
            } else {
              // Off-axis lines do not need a per-word overlay, animated mask,
              // glow and scale. Keeping only their glyphs dramatically lowers
              // the frame cost while preserving identical wrapping.
              Text(word.text)
                .font(Tokens.lyric(resolvedTypeSize))
                .foregroundStyle(Tokens.text1)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .allowsTightening(true)
            }
          }
        }
      } else {
        // LRC gives us the line boundary, not trustworthy word boundaries.
        // Light the whole line as one cue instead of animating invented word
        // timing and presenting guesses as precision.
        Text(line.text)
          .font(Tokens.lyric(resolvedTypeSize))
          .foregroundStyle(lineSyncColor)
          .multilineTextAlignment(textAlignment)
          .lineLimit(2)
          .minimumScaleFactor(0.5)
          .allowsTightening(true)
      }
      if let aidText {
        VStack(spacing: 6) {
          if let kind = aidMode.plateKind {
            Text(kind)
              .font(Tokens.display(18, .semibold))
              .tracking(3.5)
              .foregroundStyle(Tokens.text3)
          }
          Text(aidText)
            .font(Tokens.display(max(26, resolvedTypeSize * 0.32), .medium))
            .foregroundStyle(Tokens.ink.opacity(0.55))
            .multilineTextAlignment(textAlignment)
            .lineLimit(2)
            .minimumScaleFactor(0.55)
        }
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, alignment: frameAlignment)
  }

  private var resolvedTypeSize: CGFloat {
    if let typeSize { return typeSize }
    if dense { return 62 }
    if finale && look == .anthem { return 108 }
    return look.lyricSize
  }

  private var fill: Color {
    StageDirection.lane(for: line) == .room ? Tokens.ember : accent.accent
  }

  private var lineSyncColor: Color {
    guard depth.isActive else {
      return Tokens.text1
    }
    if t < line.start { return Tokens.wordUpcoming.opacity(0.85) }
    if t <= line.end { return fill }
    return Tokens.wordSung
  }

  /// Duet staging: a second vocalist's lines sit on the opposite side, the way
  /// Apple's TTML `agent` staging reads on a shared screen.
  private var isSecondaryAgent: Bool {
    guard let agent = line.agent else { return false }
    return agent != "v1"
  }

  private var horizontalAlignment: HorizontalAlignment {
    guard line.agent != nil else { return leading ? .leading : .center }
    return isSecondaryAgent ? .trailing : .leading
  }

  private var frameAlignment: Alignment {
    guard line.agent != nil else { return leading ? .leading : .center }
    return isSecondaryAgent ? .trailing : .leading
  }

  private var textAlignment: TextAlignment {
    guard line.agent != nil else { return leading ? .leading : .center }
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
  let gapToNext: Double
  var typeSize: CGFloat = 84
  var fill: Color = Tokens.accentStatic
  var listen: Bool = false
  var estimated = false
  var emphasis: Double = 0
  var held = false
  var expressiveScale = false
  var renderMode: WordRenderMode = .wipe
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || DemoLaunch.reduceMotion }

  var body: some View {
    Group {
      if renderMode == .filament {
        filamentBody
      } else {
        wipeBody
      }
    }
  }

  /// Filament mode: whole-glyph heat, no L-R mask. Opacity ramps with
  /// `wipeProgress`. Hold: 3 pt meter-blue horizon. Estimated: 0.75× heat.
  @ViewBuilder private var filamentBody: some View {
    let rawWipe = DisplayMath.wipeProgress(t: t, start: word.start, end: word.end)
    let phase = DisplayMath.wordPhase(
      t: t, start: word.start, end: word.end,
      leadin: listen ? 0 : DisplayMath.leadInWord
    )
    let baseHeat: Double = {
      switch phase {
      case .leadin, .upcoming: return 0.38
      case .current: return held ? 1.0 : 0.55 + 0.45 * rawWipe
      case .sung:
        let flash = max(0, 1.0 - (t - word.end) / 0.20)
        return 0.72 + 0.28 * flash
      }
    }()
    let heat = estimated ? baseHeat * 0.75 : baseHeat
    let filamentColor = Tokens.Glass.filament.opacity(heat)
    let glowOpacity = phase == .current ? 0.45 * rawWipe : 0.0
    ZStack(alignment: .bottom) {
      glyphs
        .foregroundStyle(filamentColor)
        .shadow(color: Tokens.Glass.filament.opacity(glowOpacity), radius: 22)
      if held && !estimated {
        Capsule()
          .fill(Tokens.Glass.holdHorizon.opacity(0.55))
          .frame(height: 2)
          .scaleEffect(x: max(0.03, CGFloat(rawWipe)), anchor: .leading)
          .offset(y: 5)
      }
    }
    .scaleEffect(phase == .current ? 1.0 + 0.04 * rawWipe : 1.0, anchor: .center)
    .transaction { $0.animation = nil }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(word.text)
  }

  @ViewBuilder private var wipeBody: some View {
    let phase = DisplayMath.wordPhase(
      t: t, start: word.start, end: word.end,
      leadin: listen ? 0 : DisplayMath.leadInWord
    )
    let rawWipe = DisplayMath.wipeProgress(t: t, start: word.start, end: word.end)
    let cut = DisplayMath.cutAmount(gapToNext: gapToNext)
    let wipe = DisplayMath.wipeWithCut(wipe: rawWipe, cut: cut)
    let dim = estimated ? 0.65 : DisplayMath.confidenceDim(score: word.score)
    let attack = DisplayMath.attackAmount(t: t, start: word.start)
    let hold = reduceMotion || !held ? 0 : DisplayMath.holdAmount(word.end - word.start)

    glyphs
      .background(alignment: .leading) {
        if held {
          glyphs.foregroundStyle(Tokens.lilac.opacity(0.16))
            .offset(x: reduceMotion ? 5 : 5 + 7 * rawWipe, y: 5)
        }
      }
      .foregroundStyle(baseColor(phase: phase))
      .overlay(alignment: .leading) {
        glyphs
          .foregroundStyle(litColor(dim: dim))
          .mask(alignment: .leading) { wipeMask(wipe) }
          .shadow(
            color: glowColor(phase: phase, hold: hold),
            radius: glowRadius(phase: phase, attack: attack, hold: hold)
          )
      }
      .background {
        RoundedRectangle(cornerRadius: 5).fill(fill.opacity(emphasis * 0.2)).padding(.horizontal, -4)
      }
      .overlay(alignment: .bottom) {
        if held {
          Capsule()
            .fill(fill.opacity(0.55))
            .frame(height: 2)
            .scaleEffect(x: max(0.03, CGFloat(rawWipe)), anchor: .leading)
            .offset(y: 5)
        }
      }
      .scaleEffect(reduceMotion || !expressiveScale ? 1 : 1 + emphasis * min(0.08, 12 / max(1, PhraseFitting.wordWidth(word.text, size: typeSize))))
      .transaction { $0.animation = nil }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(word.text)
  }

  /// Same glyphs for the base and the wipe overlay, so a squeezed long word
  /// stays aligned. `minimumScaleFactor` only kicks in when FlowLayout proposes
  /// a width smaller than the word — never mid-line, which would look uneven.
  private var glyphs: some View {
    Text(word.text)
      .font(Tokens.lyric(typeSize))
      .lineLimit(1)
      .minimumScaleFactor(0.5)
      .allowsTightening(true)
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
    let lit = fill.mixed(with: Tokens.wordSung, by: settleAmount())
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
    return fill.opacity(0.10 + 0.16 * hold)
  }

  private func glowRadius(phase: DisplayMath.WordPhase, attack: Double, hold: Double) -> CGFloat {
    guard depth.isActive, phase == .current else { return 0 }
    return reduceMotion ? 0 : 3
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

/// All adjustments are ordinary buttons. Directional gestures only move focus.
private struct LyricsTimingPanel: View {
  @EnvironmentObject private var session: LyricsSession
  @EnvironmentObject private var listening: TVListeningService
  @Environment(\.dismiss) private var dismiss
  private enum Focus: Hashable { case earlier, later, reset, live, done }
  @FocusState private var focus: Focus?

  var body: some View {
    ZStack {
      Tokens.surface0
      VStack(spacing: 36) {
        TVPageHeading(title: "Lyrics timing", subtitle: "Move the lyrics to match what you hear.")
        Text("Lyrics arrive late? Choose Earlier.\nLyrics arrive too soon? Choose Later.")
          .font(Tokens.display(28, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.center)
        Text(String(format: "%+.2f seconds", session.syncOffset))
          .font(Tokens.display(54, .semibold))
          .monospacedDigit()
          .foregroundStyle(Tokens.accentStatic)
          .accessibilityIdentifier("timingOffset")
        HStack(spacing: 24) {
          Button("Earlier") { session.nudgeSync(by: 0.05) }
            .focused($focus, equals: .earlier)
          Button("Later") { session.nudgeSync(by: -0.05) }
            .focused($focus, equals: .later)
          Button("Reset") { session.resetSync() }
            .focused($focus, equals: .reset)
          Button("Done") { dismiss() }
            .focused($focus, equals: .done)
        }
        .buttonStyle(TVPillStyle())
        NavigationLink {
          LiveListeningPanel()
        } label: {
          Label("Live listening · \(listening.status.title)", systemImage: "waveform")
        }
        .buttonStyle(TVPillStyle())
        .focused($focus, equals: .live)
        .accessibilityIdentifier("liveListening")
        Text(session.timeline.hasWordTiming
          ? "Saved for this song. Each press moves the lyrics by 0.05 seconds."
          : "Word timing is estimated for this song. This adjustment moves all words together.")
          .font(Tokens.display(24, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(48)
      .frame(maxWidth: 1080)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .task {
      try? await Task.sleep(for: .milliseconds(150))
      focus = .earlier
    }
    .onExitCommand { dismiss() }
  }
}

private struct StageCatcherStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
  }
}
