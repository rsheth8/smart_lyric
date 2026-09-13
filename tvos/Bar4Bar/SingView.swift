import Bar4BarKit
import SwiftUI

/// Full-screen lyrics. Siri Remote: play/pause, left/right nudge timing, Menu goes back.
struct SingView: View {
  let session: SingSession
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Remote hints show on arrival and after any change, then get out of the way.
  @State private var hints = true
  @State private var poke = 0

  var body: some View {
    ZStack {
      Backdrop(url: session.song.artwork, dim: 0.2)
      switch session.status {
      case .loading:
        LoadingStage(song: session.song)
          .transition(.opacity.combined(with: .scale(scale: 0.96)))
      case .failed(let message):
        FailedStage(song: session.song, message: message)
          .transition(.opacity)
      case .ready:
        TimelineView(.animation) { _ in
          LyricsStage(timeline: session.timeline, t: session.cueTime, singer: session.song.by, reduceMotion: reduceMotion)
        }
        .opacity(session.playing ? 1 : 0.35)
        .blur(radius: session.playing || reduceMotion ? 0 : 8)
        .transition(.opacity)
      }
      if session.status == .ready && !session.playing {
        Image(systemName: "pause.fill")
          .font(.system(size: 64, weight: .semibold))
          .frame(width: 170, height: 170)
          .glass(Circle())
          .accessibilityLabel("Paused")
          .transition(.scale(scale: 0.7).combined(with: .opacity))
      }
      if session.status == .ready {
        NowPlaying(session: session, upNext: model.queue.first, hints: hints)
          .frame(maxHeight: .infinity, alignment: .bottom)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(Motion.glide, value: session.status)
    .animation(Motion.snappy, value: session.playing)
    .focusable(!isFailed)
    .focusEffectDisabled()
    .onPlayPauseCommand { model.togglePlay() }
    .onMoveCommand { direction in
      switch direction {
      case .left: model.nudge(ms: -100)
      case .right: model.nudge(ms: 100)
      default: poke += 1
      }
    }
    .onExitCommand { model.endSing() }
    .onChange(of: session.status) { poke += 1 } // lyrics landing restarts the hint timer
    .onChange(of: session.playing) { poke += 1 }
    .onChange(of: session.offset) { poke += 1 }
    .task(id: poke) {
      withAnimation(Motion.snappy) { hints = true }
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled, session.playing else { return }
      withAnimation(Motion.glide) { hints = false }
    }
  }

  private var isFailed: Bool {
    if case .failed = session.status { return true }
    return false
  }
}

struct LyricsStage: View {
  let timeline: Timeline
  let t: Double
  let singer: String?
  let reduceMotion: Bool

  var body: some View {
    let lines = timeline.lines
    let current = max(0, timeline.activeLine(at: t))
    let countIn = timeline.countIn(at: t)
    ZStack {
      LyricColumn(focusY: 0.44, spacing: 34) {
        ForEach(max(0, current - 2)...min(lines.count - 1, current + 3), id: \.self) { i in
          let distance = i - current
          let scale = distance == 0 ? 1 : 0.62
          LineView(line: lines[i], t: t, active: distance == 0 && !reduceMotion)
            .scaleEffect(scale)
            .opacity(Self.opacity(distance))
            .blur(radius: reduceMotion ? 0 : min(Double(abs(distance)) * 1.6, 5))
            .layoutValue(key: LineScale.self, value: scale)
            .layoutValue(key: IsCurrentLine.self, value: distance == 0)
            .transition(.opacity)
        }
      }
      .padding(.horizontal, 90)
      // Lines further ahead fade out before they reach the now-playing bar.
      .mask {
        LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .clear, location: 0.82)], startPoint: .top, endPoint: .bottom)
      }
      .animation(reduceMotion ? .easeInOut(duration: 0.25) : Motion.glide, value: current)

      if let countIn {
        CountIn(seconds: countIn, singer: t < (lines.first?.start ?? 0) ? singer : nil)
          .frame(maxHeight: .infinity, alignment: .top)
          .padding(.top, 70)
          .transition(.opacity.combined(with: .scale(scale: 0.9)))
      }
    }
    .animation(Motion.snappy, value: countIn == nil)
  }

  /// Sung lines fade quickly; upcoming ones stay readable further ahead.
  static func opacity(_ distance: Int) -> Double {
    switch distance {
    case 0: 1
    case -1: 0.3
    case 1: 0.6
    case 2: 0.34
    case 3: 0.14
    default: 0
    }
  }
}

private struct LineScale: LayoutValueKey {
  static let defaultValue: CGFloat = 1
}

private struct IsCurrentLine: LayoutValueKey {
  static let defaultValue = false
}

/// Stacks lyric lines and slides the whole column so the current line sits at
/// `focusY`. SwiftUI animates the placements, which is the scroll.
struct LyricColumn: Layout {
  var focusY: CGFloat
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    proposal.replacingUnspecifiedDimensions()
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let width = ProposedViewSize(width: bounds.width, height: nil)
    let sizes = subviews.map { $0.sizeThatFits(width) }
    var centers: [CGFloat] = []
    var y: CGFloat = 0
    var focus: CGFloat = 0
    for (subview, size) in zip(subviews, sizes) {
      let height = size.height * subview[LineScale.self]
      centers.append(y + height / 2)
      if subview[IsCurrentLine.self] { focus = y + height / 2 }
      y += height + spacing
    }
    let shift = bounds.minY + bounds.height * focusY - focus
    for (i, subview) in subviews.enumerated() {
      subview.place(
        at: CGPoint(x: bounds.midX, y: centers[i] + shift),
        anchor: .center,
        proposal: ProposedViewSize(width: bounds.width, height: sizes[i].height)
      )
    }
  }
}

struct LineView: View {
  let line: Line
  let t: Double
  /// The line being sung: its words get the bounce and glow.
  let active: Bool

  var body: some View {
    FlowLayout(spacing: 24, lineSpacing: 2) {
      ForEach(line.words.indices, id: \.self) { i in
        let word = line.words[i]
        WordView(text: word.text, progress: wipeProgress(t, word.start, word.end), active: active)
      }
    }
    .font(.system(size: 88, weight: .heavy))
    .shadow(color: .black.opacity(0.3), radius: 20)
  }
}

/// A word that fills with the accent colour as it's sung, then settles to cream.
struct WordView: View {
  let text: String
  let progress: Double
  let active: Bool

  var body: some View {
    let singing = progress > 0 && progress < 1
    Text(text)
      .foregroundStyle(progress >= 1 ? Theme.sung : .white.opacity(0.5))
      .overlay {
        if singing {
          Text(text)
            .foregroundStyle(Theme.accent)
            .mask {
              // A soft leading edge instead of a hard cut.
              LinearGradient(
                stops: [.init(color: .black, location: progress), .init(color: .clear, location: min(1, progress + 0.14))],
                startPoint: .leading, endPoint: .trailing
              )
            }
            .shadow(color: Theme.accent.opacity(active ? 0.6 : 0), radius: 18)
        }
      }
      .scaleEffect(active && singing ? 1 + 0.05 * sin(.pi * progress) : 1, anchor: .bottom)
  }
}

struct CountIn: View {
  let seconds: Double
  let singer: String?

  var body: some View {
    let remaining = Int(seconds.rounded(.up))
    VStack(spacing: 18) {
      if let singer {
        Text("\(singer), you’re up").font(.title2.weight(.semibold)).foregroundStyle(Theme.accent)
      }
      HStack(spacing: 18) {
        ForEach(0..<3, id: \.self) { beat in
          let lit = beat < 4 - remaining
          Capsule()
            .fill(Theme.accent.opacity(lit ? 1 : 0.22))
            .frame(width: lit ? 64 : 22, height: 22)
        }
      }
      .animation(Motion.snappy, value: remaining)
    }
    .padding(.horizontal, 40)
    .padding(.vertical, 24)
    .glass(RoundedRectangle(cornerRadius: 34, style: .continuous))
  }
}

struct NowPlaying: View {
  let session: SingSession
  let upNext: Song?
  let hints: Bool

  var body: some View {
    VStack(spacing: 20) {
      HStack(spacing: 24) {
        Artwork(url: session.song.artwork)
          .frame(width: 76, height: 76)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text(session.song.track).font(.headline)
          Text(session.song.by.map { "\(session.song.artist) · \($0) singing" } ?? session.song.artist)
            .font(.callout).foregroundStyle(.secondary)
        }
        Spacer(minLength: 40)
        if session.offset != 0 {
          Text(String(format: "%+.1fs", session.offset))
            .font(.callout.monospacedDigit().weight(.semibold))
            .foregroundStyle(Theme.accent)
            .contentTransition(.numericText(value: session.offset))
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .background(Theme.accent.opacity(0.16), in: Capsule())
            .transition(.scale.combined(with: .opacity))
        }
        if hints {
          HStack(spacing: 30) {
            Label("Timing", systemImage: "arrow.left.and.right")
            Label(session.playing ? "Pause" : "Resume", systemImage: "playpause.fill")
            Label("Back", systemImage: "chevron.backward")
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .transition(.opacity)
        } else if let upNext {
          Text("Up next · \(upNext.track)\(upNext.by.map { " · \($0)" } ?? "")")
            .font(.callout).foregroundStyle(.secondary)
            .transition(.opacity)
        }
      }
      TimelineView(.animation(minimumInterval: 0.1)) { _ in
        let duration = session.timeline.duration
        let progress = duration > 0 ? min(1, max(0, session.position / duration)) : 0
        Capsule()
          .fill(.white.opacity(0.14))
          .overlay(alignment: .leading) {
            GeometryReader { geo in
              Capsule().fill(Theme.accent).frame(width: geo.size.width * progress)
            }
          }
          .frame(height: 6)
      }
    }
    .lineLimit(1)
    .padding(.horizontal, 36)
    .padding(.vertical, 24)
    .glass(RoundedRectangle(cornerRadius: 32, style: .continuous))
    .padding(.horizontal, 40)
    .padding(.bottom, 20)
    .animation(Motion.snappy, value: session.offset)
    .animation(Motion.glide, value: hints)
  }
}

struct LoadingStage: View {
  let song: Song
  @State private var breathe = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 48) {
      Artwork(url: song.artwork)
        .frame(width: 380, height: 380)
        .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
        .shadow(color: .black.opacity(0.5), radius: 60, y: 30)
        .scaleEffect(breathe ? 1.03 : 0.98)
      VStack(spacing: 12) {
        if let by = song.by {
          Text("\(by), get ready".uppercased()).font(.caption.weight(.semibold)).tracking(4).foregroundStyle(Theme.accent)
        }
        Text(song.track).font(.system(size: 60, weight: .bold)).lineLimit(1)
        Text(song.artist).font(.title3).foregroundStyle(.secondary)
      }
      HStack(spacing: 16) {
        ProgressView()
        Text("Finding the lyrics").foregroundStyle(.secondary)
      }
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 1.8).repeatForever()) { breathe = true }
    }
  }
}

struct FailedStage: View {
  let song: Song
  let message: String
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(spacing: 36) {
      Artwork(url: song.artwork)
        .frame(width: 240, height: 240)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .saturation(0.3)
      Text(message).font(.title2.weight(.semibold))
      Text("Lyrics come from public databases, and not every song has them yet.")
        .font(.callout).foregroundStyle(.secondary)
      HStack(spacing: 32) {
        if let next = model.queue.first {
          Button("Sing “\(next.track)”") { model.playNext() }
        }
        Button("Choose another song") { model.endSing() }
      }
      .padding(.top, 12)
    }
    .multilineTextAlignment(.center)
  }
}

/// Words wrapped into centred rows.
struct FlowLayout: Layout {
  var spacing: CGFloat
  var lineSpacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews)
    let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
    return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in arrange(width: bounds.width, subviews) {
      var x = bounds.midX - row.width / 2
      for i in row.indices {
        let size = subviews[i].sizeThatFits(.unspecified)
        subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
    var rows: [Row] = []
    var row = Row()
    for i in subviews.indices {
      let size = subviews[i].sizeThatFits(.unspecified)
      if !row.indices.isEmpty && row.width + spacing + size.width > width {
        rows.append(row)
        row = Row()
      }
      row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.indices.append(i)
    }
    if !row.indices.isEmpty { rows.append(row) }
    return rows
  }
}
