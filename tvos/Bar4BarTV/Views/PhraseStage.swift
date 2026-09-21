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
      // Loop section: seek back to the current section start when the cue enters the next.
      let _ = {
        guard session.loopSection, music.isPlaying else { return }
        let cue = sample.cue
        guard let cur = session.sections.last(where: { $0.start <= cue }),
              let nxt = session.sections.first(where: { $0.start > cue }),
              cue >= nxt.start - 0.1 else { return }
        music.seek(to: max(0, cur.start - session.totalAlignment - session.singerLead))
      }()
      let lines = session.timeline.lines
      let activeLi = DisplayMath.resolveActiveLine(lines, t: sample.cue)
      let gap = DisplayMath.gapState(lines: lines, t: sample.cue, activeLi: activeLi)
      ZStack {
        PosterEnvironment(state: state, intensity: session.intensity,
          reduceMotion: reduceMotion,
          letters: InstallationForms.initials(music.nowPlaying?.title ?? "BAR FOR BAR"),
          cheer: session.audienceAccent.amount(at: Date().timeIntervalSinceReferenceDate),
          artworkAccent: session.accent.accent)
        if state.ending {
          songSummaryOverlay(sungCount: runtime.totalSung, totalLines: lines.count)
        } else if gap.instrumental, let eta = gap.nextVocalIn, eta > 8 {
          instrumentalCountdown(eta: eta, lines: lines, activeLi: activeLi)
        } else {
          board(state: state, cueTime: sample.cue)
        }
        if !state.ending {
          Color.clear
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(phraseRoleLabel(state))
            .accessibilityIdentifier("phraseRole")
        }
      }

    }
    }
    .allowsHitTesting(false)
  }

  @ViewBuilder private func board(state: StagePresentation, cueTime: Double) -> some View {
    if session.timeline.lines.indices.contains(state.line) {
      let line = displayLine(at: state.line)
      let turn = SingerTurnPreview(timeline: session.timeline, state: state,
        cueTime: cueTime, preview: session.previewSeconds, mode: session.partyMode)
      GeometryReader { geo in
        let readingWidth = min(1380, max(620, geo.size.width - 400))
        let size = runtime.typeSize(for: line, width: readingWidth)
        ZStack {
          // Ambient accent bloom: radial glow behind the active phrase,
          // pulsing through a sine bell over the line's duration.
          let lineEnd = line.words.last?.end ?? line.start
          let lineProgress = line.start < lineEnd
            ? max(0, min(1, (cueTime - line.start) / (lineEnd - line.start)))
            : 0.0
          let bloomPulse = reduceMotion ? 0.0 : sin(lineProgress * .pi)
          let bloomOpacity = 0.07 + 0.11 * bloomPulse
          RadialGradient(
            gradient: Gradient(colors: [
              session.accent.accent.opacity(bloomOpacity),
              session.accent.accent.opacity(bloomOpacity * 0.3),
              .clear
            ]),
            center: .center,
            startRadius: 0,
            endRadius: geo.size.height * 0.46
          )
          .frame(width: geo.size.width, height: geo.size.height * 0.9)
          .position(x: geo.size.width * 0.5, y: geo.size.height * 0.43)
          .blendMode(.screen)
          .allowsHitTesting(false)

          // The reading plane is fixed. Preview length and timing revisions
          // cannot move the active phrase around the television.
          let hiddenWords: Set<Int> = session.blankNthWord > 1
            ? Set(line.words.indices.filter { ($0 + 1) % session.blankNthWord == 0 })
            : []
          VStack(spacing: 16) {
            HStack(spacing: 13) {
              Text(state.kind.sectionLabel)
                .foregroundStyle(session.accent.accent)
              Text("/")
                .foregroundStyle(Tokens.text3)
              Text(roleName(for: state))
                .foregroundStyle(Tokens.ink)
            }
            .font(Tokens.caption(20)).tracking(3.5)
            .accessibilityIdentifier("partyFlipFlash")
            LyricLineView(
              line: line, t: cueTime, depth: .active,
              accent: session.accent,
              wordTiming: true,
              listen: session.performanceMode == .listen,
              typeSize: size,
              emphasisWord: state.emphasis, emphasisAmount: 0,
              heldWord: state.hold, expressiveScale: false,
              estimatedWords: Set(line.words.indices.filter { session.timeline.quality(line: state.line, word: $0) == .estimated }),
              hiddenWords: hiddenWords, renderMode: .filament
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("currentPhrase")
          }
          .frame(width: readingWidth, height: 340)
          .opacity(0.85 + 0.15 * state.entrance)
          .offset(y: reduceMotion || session.intensity == .focus ? 0 : (1 - state.entrance) * 8)
          .position(x: geo.size.width * 0.5, y: geo.size.height * 0.43)

          ghostOrAid(state: state, cueTime: cueTime, currentSize: size)
            .frame(width: readingWidth, height: 150)
            .position(x: geo.size.width * 0.5, y: geo.size.height * 0.70)

          if line.start > cueTime, line.start - cueTime <= (state.kind == .instrumental ? 8 : 3.5) {
            Text("SING IN \(max(1, Int(ceil(line.start - cueTime))))")
              .font(Tokens.caption(20)).tracking(3)
              .foregroundStyle(Tokens.ink)
              .padding(.horizontal, 24).padding(.vertical, 11)
              .background(session.accent.accent, in: Capsule())
              .position(x: geo.size.width * 0.5, y: geo.size.height * 0.18)
          }

          if let turn {
            VStack(alignment: .leading, spacing: 8) {
              Text("NEXT VOICE")
                .font(Tokens.caption(15)).tracking(2.5)
                .foregroundStyle(Tokens.lilac)
              Text(turn.role)
                .font(Tokens.editorial(36))
                .foregroundStyle(Tokens.ink)
              Text("IN \(turn.seconds)")
                .font(Tokens.caption(17)).tracking(2)
                .foregroundStyle(session.accent.accent)
            }
            .frame(width: 270, alignment: .leading)
            .position(x: geo.size.width * 0.16, y: geo.size.height * 0.20)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(turn.role) sings in \(turn.seconds) seconds")
            .accessibilityIdentifier("singerHandoff")
          }

          if state.dense && state.kind != .chorus && state.kind != .finale {
            Text("FAST · READ AHEAD")
              .font(Tokens.caption(18)).tracking(2)
              .foregroundStyle(session.accent.accent)
              .frame(width: geo.size.width - 190, alignment: .trailing)
              .position(x: geo.size.width * 0.5, y: 70)
              .accessibilityIdentifier("denseBadge")
          }

          Text(faceplateText)
            .font(Tokens.caption(19)).tracking(1.7)
            .foregroundStyle(Tokens.text2)
            .monospacedDigit()
            .position(x: geo.size.width * 0.5, y: geo.size.height - 56)
        }
      }
    }
  }

  @ViewBuilder private func ghostOrAid(state: StagePresentation, cueTime: Double, currentSize: CGFloat) -> some View {
    if let aid = aidText(displayLine(at: state.line)) {
      Text(aid)
        .font(Tokens.caption(31))
        .foregroundStyle(Tokens.ink)
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.75)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("phraseAid")
    } else if let next = Participation.nextSingableLine(after: state.line, in: session.timeline) {
      VStack(spacing: 11) {
        Text(upNextLabel(at: next))
          .font(Tokens.caption(17)).tracking(3)
          .foregroundStyle(Tokens.lilac)
        Text(session.timeline.lines[next].text)
          .font(Tokens.lyric(min(40, currentSize * 0.55)))
          .foregroundStyle(Tokens.ink.opacity(0.88))
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .minimumScaleFactor(0.72)
      }
      .frame(maxWidth: .infinity)
    }
  }

  private func roleName(for state: StagePresentation) -> String {
    switch ParticipationMode(savedValue: session.partyMode) {
    case .everyone: return "EVERYONE"
    case .duo: return Participation.side(at: state.line, in: session.timeline)?.rawValue ?? "DUO"
    case .solo: return "SOLO"
    }
  }

  private func upNextLabel(at index: Int) -> String {
    switch ParticipationMode(savedValue: session.partyMode) {
    case .everyone: return "UP NEXT  /  EVERYONE"
    case .duo: return "UP NEXT  /  \(Participation.side(at: index, in: session.timeline)?.rawValue ?? "DUO")"
    case .solo: return "UP NEXT"
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
    switch ParticipationMode(savedValue: session.partyMode) {
    case .duo: return Participation.side(at: state.line, in: session.timeline)?.rawValue ?? "Duo"
    case .everyone: return "Everyone"
    case .solo: return "Your stage"
    }
  }

  @ViewBuilder private func songSummaryOverlay(sungCount: Int, totalLines: Int) -> some View {
    ZStack {
      Tokens.surface0
      Text("B4B")
        .font(Tokens.editorial(510))
        .foregroundStyle(session.accent.accent.opacity(0.12))
        .rotationEffect(.degrees(-12))
        .offset(x: 570, y: 120)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 25) {
        Text("THE ROOM WAS YOURS")
          .font(Tokens.caption(22)).tracking(5)
          .foregroundStyle(session.accent.accent)
        Text("Every voice\nleaves a mark.")
          .font(Tokens.editorial(94, italic: true))
          .lineSpacing(-8)
        Text("\(sungCount) of \(totalLines) phrases followed")
          .font(Tokens.caption(27))
          .foregroundStyle(Tokens.text2)
          .accessibilityIdentifier("songSummaryCount")
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
    .foregroundStyle(Tokens.ink)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("songSummaryCard")
  }

  @ViewBuilder private func instrumentalCountdown(eta: Double, lines: [LyricLine], activeLi: Int) -> some View {
    let nextIdx = activeLi + 1
    // Album art fades in when there's a long instrumental ahead, out as vocals approach
    let artworkAlpha = min(1.0, max(0, (eta - 4) / 6.0))
    // "INSTRUMENTAL" label only when far from next vocal (>10s)
    let labelAlpha = max(0.0, min(1.0, (eta - 10.0) / 4.0))
    ZStack {
      PictureArtwork(
        url: music.nowPlaying?.artworkURL,
        tint: session.accent.accent,
        amount: artworkAlpha
      )
      VStack(spacing: 20) {
        Spacer()
        // Section label — only during long instrumentals
        HStack(spacing: 10) {
          Image(systemName: "music.note.list")
            .font(.system(size: 16, weight: .medium))
          Text("INSTRUMENTAL")
            .font(Tokens.display(22, .semibold))
            .tracking(5)
        }
        .foregroundStyle(Tokens.Glass.legend.opacity(0.6))
        .opacity(labelAlpha)
        if lines.indices.contains(nextIdx) {
          Text(lines[nextIdx].text)
            .font(Tokens.lyric(52))
            .foregroundStyle(Tokens.ink.opacity(0.84))
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, 200)
        }
        Spacer().frame(height: 100)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
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
  private var endingLatched = false
  private var lastSeekRevision = -1
  func typeSize(for line: LyricLine, width: CGFloat) -> CGFloat {
    if let fittedSize, fittedWidth == width { return fittedSize }
    // A long translation has to fit the same fixed reading plane as a short
    // hook. A floor of 56pt made five-row phrases collide with the aid below.
    let fitted = PhraseFitting.size(words: line.words.map(\.text), width: width,
      height: 270, minSize: 30)
    fittedWidth = width
    fittedSize = min(82, fitted)
    return fittedSize!
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
    if sample.seekRevision != lastSeekRevision { lastSeekRevision = sample.seekRevision; endingLatched = false }
    var state = director.advance(timeline: timeline, sections: sections, choreography: choreography, sample: sample, preview: preview)
    if state.ending { endingLatched = true }
    if endingLatched { state.ending = true }
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
