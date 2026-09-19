import SwiftUI
import Bar4BarCore

/// The only display loop. Controls and focus are siblings, never children.
struct PhraseStage: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || DemoLaunch.reduceMotion }
  @State private var runtime = PhraseRuntime()
  @State private var lightClock = StageLightClock()

  var body: some View {
    GeometryReader { geometry in
    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !music.isPlaying && session.audienceAccent.startedAt == nil)) { _ in
      let sample = StageSample(playback: music.liveTime, audible: music.liveTime + session.totalAlignment,
        cue: music.liveTime + session.totalAlignment + session.singerLead, playing: music.isPlaying,
        timingRevision: session.timingRevision, seekRevision: music.stageSeekRevision)
      let state = runtime.advance(timeline: session.timeline, sections: session.sections,
        choreography: session.choreography, sample: sample, preview: session.previewSeconds)
      // Loop section: when enabled, seek back to the current section's start
      // as soon as the cue crosses into the next section.
      if session.loopSection, music.isPlaying {
        let cue = sample.cue
        if let currentSection = session.sections.last(where: { $0.start <= cue }),
           let nextSection = session.sections.first(where: { $0.start > cue }),
           cue >= nextSection.start - 0.1 {
          music.seek(to: max(0, currentSection.start - session.totalAlignment - session.singerLead))
        }
      }
      let lines = session.timeline.lines
      let activeLi = DisplayMath.resolveActiveLine(lines, t: sample.cue)
      let gap = DisplayMath.gapState(lines: lines, t: sample.cue, activeLi: activeLi)
      let look = StageLookMath.resolve(lines: lines, t: sample.cue, sections: session.sections, reduceMotion: reduceMotion)
      let light = lightClock.advance(look: look, nextVocalIn: gap.nextVocalIn, now: Date(), reduceMotion: reduceMotion)
      ZStack {
        ListeningGlass(state: state, intensity: session.intensity,
          partyMode: session.partyMode, sideA: state.line.isMultiple(of: 2),
          cheer: session.audienceAccent.amount(at: Date().timeIntervalSinceReferenceDate),
          playing: music.isPlaying, reduceMotion: reduceMotion,
          artworkURL: music.nowPlaying?.artworkURL,
          lines: lines, cueTime: sample.cue,
          previewSeconds: session.previewSeconds,
          nowPlayingTitle: music.nowPlaying?.title ?? "BAR FOR BAR",
          nowPlayingArtist: music.nowPlaying?.artist ?? "BAR4BAR")
        CinematicStageFX(
          look: look, light: light, accent: session.accent,
          t: state.motionTime,
          wordImpact: StageDirection.wordImpact(lines: lines, t: sample.cue, activeLi: activeLi),
          chorusDrop: StageDirection.chorusDrop(sections: session.sections, t: sample.cue),
          finale: StageDirection.isFinale(sections: session.sections, t: sample.cue),
          roomEnergy: session.audienceAccent.amount(at: Date().timeIntervalSinceReferenceDate),
          reduceMotion: reduceMotion
        )
        if gap.instrumental, let eta = gap.nextVocalIn {
          instrumentalCountdown(eta: eta, lines: lines, activeLi: activeLi)
        }
        board(state: state, cueTime: sample.cue, width: max(1, geometry.size.width - 350))
        if state.ending {
          songSummaryOverlay(sungCount: runtime.totalSung, totalLines: lines.count)
        }
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
      let sectionAlpha = runtime.sectionLabelAlpha(kind: state.kind, t: cueTime)
      let dotProgress = min(1.0, state.entrance / 0.6)
      GeometryReader { geo in
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          // Current line — centered horizontally, filament mode
          let hiddenWords: Set<Int> = session.blankNthWord > 1
            ? Set(line.words.indices.filter { ($0 + 1) % session.blankNthWord == 0 })
            : []
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
            hiddenWords: hiddenWords,
            renderMode: .filament     // whole-glyph heat, no wipe mask
          )
          .padding(.vertical, 12)
          .opacity(0.65 + 0.35 * state.entrance)
          .offset(y: reduceMotion ? 0 : (1 - state.entrance) * 16)
          .scaleEffect(reduceMotion ? 1 : (0.94 + 0.06 * state.entrance), anchor: .center)
          .transaction { $0.animation = nil }  // 60 fps TimelineView drives this; no SwiftUI spring on top
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("currentPhrase")

          // Line-start cue dot — shrinks in as the line settles
          if state.entrance < 0.6 && !reduceMotion {
            Circle()
              .fill(Tokens.Glass.filament.opacity((1 - dotProgress) * 0.50))
              .frame(width: max(4, CGFloat(12 - dotProgress * 8)), height: max(4, CGFloat(12 - dotProgress * 8)))
              .padding(.top, 6)
          }

          // Party singer indicator
          if session.partyMode == "Take turns" {
            let flipAlpha = runtime.sideFlipAlpha(isEven: state.line.isMultiple(of: 2), t: cueTime)
            ZStack {
              Text(state.line.isMultiple(of: 2) ? "— YOU —" : "— THEM —")
                .font(Tokens.display(15, .semibold))
                .tracking(3)
                .foregroundStyle(Tokens.Glass.filament.opacity(0.40))
              if flipAlpha > 0.01 {
                Text(state.line.isMultiple(of: 2) ? "YOUR TURN" : "THEIR TURN")
                  .font(Tokens.display(22, .bold))
                  .tracking(3)
                  .foregroundStyle(Tokens.Glass.filament.opacity(flipAlpha))
                  .scaleEffect(0.85 + 0.15 * flipAlpha)
              }
            }
            .padding(.top, 8)
          }

          // Upcoming lines runway + language aid
          ghostOrAid(state: state, cueTime: cueTime, currentSize: size)
            .padding(.top, session.partyMode == "Take turns" ? 20 : 48)

          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)

        // Section label pill — fades in at section boundaries
        if sectionAlpha > 0.01 {
          VStack {
            HStack {
              Text(state.kind.sectionLabel)
                .font(Tokens.display(15, .semibold))
                .tracking(3.5)
                .foregroundStyle(Tokens.Glass.legend)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Tokens.surface2.opacity(sectionAlpha), in: Capsule())
              Spacer()
            }
            Spacer()
          }
          .opacity(sectionAlpha)
          .padding(.top, 44)
          .padding(.leading, 36)
        }

        // Dense/fast section badge — top right
        if state.dense {
          VStack {
            HStack {
              Spacer()
              HStack(spacing: 5) {
                Image(systemName: "bolt.fill")
                  .font(.system(size: 13, weight: .bold))
                Text("FAST")
                  .font(Tokens.display(13, .bold))
                  .tracking(2)
              }
              .foregroundStyle(Tokens.Glass.meter.opacity(0.65))
              .padding(.horizontal, 10)
              .padding(.vertical, 5)
              .background(Tokens.surface2.opacity(0.6), in: Capsule())
            }
            Spacer()
          }
          .padding(.top, 44)
          .padding(.trailing, 36)
        }

        // Faceplate: ARTIST · TITLE · M:SS at bottom
        VStack {
          Spacer()
          Text(faceplateText)
            .font(Tokens.display(24))
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
      let pulse = 0.28 + 0.14 * sin(cueTime * 1.1)
      VStack(spacing: 16) {
        Text(session.timeline.lines[next].text)
          .font(Tokens.lyric(currentSize * 0.42))
          .foregroundStyle(Tokens.Glass.filament.opacity(pulse))
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .minimumScaleFactor(0.65)
          .offset(y: CGFloat(sin(cueTime * 0.38) * 6))
        if session.timeline.lines.indices.contains(next + 1) {
          Text(session.timeline.lines[next + 1].text)
            .font(Tokens.lyric(currentSize * 0.30))
            .foregroundStyle(Tokens.Glass.filament.opacity(0.16))
            .multilineTextAlignment(.center)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        if session.timeline.lines.indices.contains(next + 2) {
          Text(session.timeline.lines[next + 2].text)
            .font(Tokens.lyric(currentSize * 0.22))
            .foregroundStyle(Tokens.Glass.filament.opacity(0.09))
            .multilineTextAlignment(.center)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
      }
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

  @ViewBuilder private func songSummaryOverlay(sungCount: Int, totalLines: Int) -> some View {
    VStack(spacing: 20) {
      Spacer()
      Text("WELL DONE")
        .font(Tokens.display(32, .bold))
        .tracking(6)
      Text("\(sungCount) / \(totalLines)")
        .font(Tokens.lyric(72))
        .monospacedDigit()
      Text("LINES SUNG")
        .font(Tokens.display(20))
        .tracking(4)
        .opacity(0.6)
      Spacer()
    }
    .foregroundStyle(Tokens.Glass.filament)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.black.opacity(0.72))
  }

  @ViewBuilder private func instrumentalCountdown(eta: Double, lines: [LyricLine], activeLi: Int) -> some View {
    let showCount = eta < 8 && eta > 0.2
    let countAlpha = showCount ? min(1.0, (8.0 - eta) / 2.0) : 0.0
    let countText = eta > 1.2 ? "BACK IN \(Int(ceil(eta)))s" : "GET READY"
    let nextIdx = activeLi + 1
    VStack(spacing: 20) {
      Spacer()
      if showCount {
        HStack(spacing: 8) {
          Image(systemName: "music.note")
            .font(.system(size: 16, weight: .medium))
          Text(countText)
            .font(Tokens.display(22, .semibold))
            .tracking(4)
        }
        .foregroundStyle(Tokens.Glass.legend.opacity(countAlpha))
      }
      if lines.indices.contains(nextIdx) {
        Text(lines[nextIdx].text)
          .font(Tokens.lyric(52))
          .foregroundStyle(Tokens.Glass.filament.opacity(0.32))
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .minimumScaleFactor(0.6)
          .padding(.horizontal, 200)
      }
      Spacer().frame(height: 100)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
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
  private var lastKind: Choreography.Kind = .verse
  private var kindChangedAt: Double = -100.0

  func sectionLabelAlpha(kind: Choreography.Kind, t: Double) -> Double {
    if kind != lastKind { lastKind = kind; kindChangedAt = t }
    let age = t - kindChangedAt
    guard age < 3.0 else { return 0 }
    return min(1.0, age / 0.25) * max(0.0, 1.0 - max(0, age - 1.5) / 1.5)
  }

  private var lastSide = false
  private var sideFlippedAt: Double = -100.0

  func sideFlipAlpha(isEven: Bool, t: Double) -> Double {
    if isEven != lastSide { lastSide = isEven; sideFlippedAt = t }
    let age = t - sideFlippedAt
    guard age < 1.5 else { return 0 }
    return min(1.0, age / 0.15) * max(0.0, 1.0 - max(0, age - 0.5) / 1.0)
  }

  private var sungLines = Set<Int>()
  var totalSung: Int { sungLines.count }

  func advance(timeline: Timeline, sections: [Sections.Section], choreography: Choreography?, sample: StageSample, preview: Double) -> StagePresentation {
    let state = director.advance(timeline: timeline, sections: sections, choreography: choreography, sample: sample, preview: preview)
    if state.line != displayedLine || frozenLine == nil {
      if timeline.lines.indices.contains(state.line) { frozenLine = timeline.lines[state.line] }
      fittedSize = nil
      displayedLine = state.line
    }
    if state.entrance > 0.5 { sungLines.insert(state.line) }
    return state
  }
}


private extension Choreography.Kind {
  var sectionLabel: String {
    switch self {
    case .verse: return "VERSE"
    case .chorus: return "CHORUS"
    case .build: return "BUILD"
    case .instrumental: return "INSTRUMENTAL"
    case .finale: return "FINALE"
    }
  }
}
