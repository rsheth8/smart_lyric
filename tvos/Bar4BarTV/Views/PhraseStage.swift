import SwiftUI
import Bar4BarCore

/// The only display loop. Controls and focus are siblings, never children.
struct PhraseStage: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || DemoLaunch.reduceMotion }
  @State private var runtime = PhraseRuntime()

  var body: some View {
    GeometryReader { geometry in
    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !music.isPlaying && session.audienceAccent.startedAt == nil)) { _ in
      let sample = StageSample(playback: music.liveTime, audible: music.liveTime + session.totalAlignment,
        cue: music.liveTime + session.totalAlignment + session.singerLead, playing: music.isPlaying,
        timingRevision: session.timingRevision, seekRevision: music.stageSeekRevision)
      let state = runtime.advance(timeline: session.timeline, sections: session.sections,
        choreography: session.choreography, sample: sample, preview: session.previewSeconds)
      ZStack {
        ListeningGlass(state: state, intensity: session.intensity,
          partyMode: session.partyMode, sideA: state.line.isMultiple(of: 2),
          cheer: session.audienceAccent.amount(at: Date().timeIntervalSinceReferenceDate),
          playing: music.isPlaying, reduceMotion: reduceMotion,
          artworkURL: music.nowPlaying?.artworkURL,
          lines: session.timeline.lines, cueTime: sample.cue,
          previewSeconds: session.previewSeconds,
          nowPlayingTitle: music.nowPlaying?.title ?? "BAR FOR BAR",
          nowPlayingArtist: music.nowPlaying?.artist ?? "BAR4BAR")
        board(state: state, cueTime: sample.cue, width: max(1, geometry.size.width - 350))
        // Hidden accessibility element — VoiceOver announces singer role; UITests can assert it.
        Color.clear
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(phraseRoleLabel(state))
          .accessibilityIdentifier("phraseRole")
      }

    }
    }
    .allowsHitTesting(false)
  }

  @ViewBuilder private func board(state: StagePresentation, cueTime: Double, width: CGFloat) -> some View {
    if session.timeline.lines.indices.contains(state.line) {
      let line = displayLine(at: state.line)
      let size = runtime.typeSize(for: line, width: width)
      GeometryReader { geo in
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          // Current line — centered horizontally, filament mode
          LyricLineView(
            line: line,
            t: state.ending ? line.end + 1 : cueTime,
            depth: .active,
            accent: AccentPalette(accent: Tokens.Glass.filament, soft: Tokens.Glass.filamentSung, glow: Tokens.Glass.filament),
            wordTiming: true,
            listen: session.performanceMode == .listen,
            typeSize: size,
            leading: false,           // centered
            emphasisWord: state.emphasis,
            emphasisAmount: 0,        // no scale punch on Glass
            heldWord: state.hold,
            expressiveScale: false,
            estimatedWords: Set(line.words.indices.filter { session.timeline.quality(line: state.line, word: $0) == .estimated }),
            renderMode: .filament     // whole-glyph heat, no wipe mask
          )
          .padding(.vertical, 12)
          .opacity(0.65 + 0.35 * state.entrance)
          .offset(y: reduceMotion ? 0 : (1 - state.entrance) * 16)
          .transaction { $0.animation = nil }  // 60 fps TimelineView drives this; no SwiftUI spring on top
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("currentPhrase")

          // Ghost next line or language aid (48 pt below current)
          ghostOrAid(state: state, cueTime: cueTime, currentSize: size)
            .padding(.top, 48)

          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)

        // Faceplate: ARTIST · TITLE · M:SS at bottom (88% of panel)
        VStack {
          Spacer()
          Text(faceplateText)
            .font(.system(size: 24, weight: .regular, design: .default))
            .tracking(2.5)
            .foregroundStyle(Tokens.Glass.legend)
            .frame(maxWidth: .infinity, alignment: .center)
            .monospacedDigit()
            .padding(.bottom, 54)
        }
      }
      .padding(.horizontal, width * 0.15)  // ~15% side inset keeps text away from meters
    }
  }

  @ViewBuilder private func ghostOrAid(state: StagePresentation, cueTime: Double, currentSize: CGFloat) -> some View {
    if let aid = aidText(displayLine(at: state.line)) {
      Text(aid)
        .font(Tokens.display(25, .medium))
        .foregroundStyle(Tokens.Glass.legend)
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.65)
        .opacity(0.5)
        .frame(maxWidth: .infinity)
    } else if let next = state.next, session.timeline.lines.indices.contains(next) {
      let nextLine = session.timeline.lines[next]
      Text(nextLine.text)
        .font(Tokens.lyric(currentSize * 0.42))
        .foregroundStyle(Tokens.Glass.filament.opacity(0.35))
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.65)
        .frame(maxWidth: .infinity)
    }
  }

  private var faceplateText: String {
    let artist = music.nowPlaying?.artist ?? "BAR4BAR"
    let title = music.nowPlaying?.title ?? "BAR FOR BAR"
    let elapsed = timeLabel(music.liveTime)
    return "\(artist)  ·  \(title)  ·  \(elapsed)"
  }

  private func timeLabel(_ time: Double) -> String {
    let v = max(0, Int(time.isFinite ? time : 0))
    return String(format: "%d:%02d", v / 60, v % 60)
  }

  private func displayLine(at index: Int) -> LyricLine {
    var line = session.timeline.lines[index]
    // Text and therefore wrapping are fixed for the lifetime of the phrase.
    if let frozenLine = runtime.frozenLine, frozenLine.words.count == line.words.count {
      for i in line.words.indices { line.words[i].text = frozenLine.words[i].text }
    }
    line.agent = nil // Party roles are explicit; provider vocal agents do not move the reading position.
    return line
  }
  private func aidText(_ line: LyricLine) -> String? {
    session.aidMode == .roman ? line.roman : session.aidMode == .english ? line.english : nil
  }
  private func phraseRoleLabel(_ state: StagePresentation) -> String {
    if session.partyMode == "Take turns" {
      return state.line.isMultiple(of: 2) ? "Side A" : "Side B"
    }
    return session.partyMode == "Everyone" ? "Everyone" : "Your stage"
  }
}

/// Owned by the TimelineView. This non-observable cache advances only on display
/// samples; it never schedules another SwiftUI update or touches the focus tree.
private final class PhraseRuntime {
  private var director = PhraseDirector()
  private var displayedLine = -1
  var frozenLine: LyricLine?
  private var fittedSize: CGFloat?
  private var fittedWidth: CGFloat?
  func typeSize(for line: LyricLine, width: CGFloat) -> CGFloat {
    if let fittedSize, fittedWidth == width { return fittedSize }
    // Glass floor: tries 64 first, falls back to 56, absolute minimum 52.
    let bandH: CGFloat = 260  // ~24% of 1080 for the current line slot
    for floor: CGFloat in [64, 56, 52] {
      let s = PhraseFitting.size(words: line.words.map(\.text), width: width, height: bandH, minSize: floor)
      if s >= floor { fittedWidth = width; fittedSize = s; return s }
    }
    fittedWidth = width
    fittedSize = 52
    return 52
  }
  func advance(timeline: Timeline, sections: [Sections.Section], choreography: Choreography?, sample: StageSample, preview: Double) -> StagePresentation {
    let state = director.advance(timeline: timeline, sections: sections, choreography: choreography, sample: sample, preview: preview)
    if state.line != displayedLine || frozenLine == nil {
      if timeline.lines.indices.contains(state.line) { frozenLine = timeline.lines[state.line] }
      fittedSize = nil
      displayedLine = state.line
    }
    return state
  }
}
