import Bar4BarKit
import SwiftUI

/// Full-screen lyrics. Siri Remote: play/pause, left/right nudge timing, Menu goes back.
struct SingView: View {
  let session: SingSession
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      Backdrop(url: session.song.artwork)
      switch session.status {
      case .loading:
        VStack(spacing: 32) {
          ProgressView()
          Text("Finding lyrics for “\(session.song.track)”…").font(.title3).foregroundStyle(.secondary)
        }
      case .failed(let message):
        VStack(spacing: 40) {
          Text(message).font(.title2)
          Button("Back to songs") { model.endSing() }
        }
      case .ready:
        TimelineView(.animation) { _ in
          LyricsStage(timeline: session.timeline, t: session.cueTime, singer: session.song.by)
        }
      }
      NowPlaying(session: session)
        .frame(maxHeight: .infinity, alignment: .bottom)
    }
    .overlay(alignment: .top) { ToastView(text: model.toast) }
    .focusable(!isFailed)
    .focusEffectDisabled()
    .onPlayPauseCommand { model.togglePlay() }
    .onMoveCommand { direction in
      switch direction {
      case .left: model.nudge(ms: -100)
      case .right: model.nudge(ms: 100)
      default: break
      }
    }
    .onExitCommand { model.endSing() }
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

  var body: some View {
    let lines = timeline.lines
    let current = max(0, timeline.activeLine(at: t))
    let window = max(0, current - 1)...min(lines.count - 1, current + 2)
    ZStack {
      VStack(spacing: 36) {
        ForEach(Array(window), id: \.self) { i in
          LineView(line: lines[i], t: t, role: i < current ? .past : i == current ? .current : .upcoming)
            .transition(.asymmetric(insertion: .move(edge: .bottom), removal: .move(edge: .top)).combined(with: .opacity))
        }
      }
      .padding(.horizontal, 60)
      .animation(.smooth(duration: 0.6), value: current)

      if let seconds = timeline.countIn(at: t) {
        CountIn(seconds: seconds, singer: t < (lines.first?.start ?? 0) ? singer : nil)
          .frame(maxHeight: .infinity, alignment: .top)
          .padding(.top, 70)
      }
    }
  }
}

struct LineView: View {
  enum Role { case past, current, upcoming }
  let line: Line
  let t: Double
  let role: Role

  var body: some View {
    if role == .current {
      FlowLayout(spacing: 26, lineSpacing: 4) {
        ForEach(line.words.indices, id: \.self) { i in
          let word = line.words[i]
          WordView(text: word.text, progress: wipeProgress(t, word.start, word.end))
        }
      }
      .font(.system(size: 92, weight: .heavy))
      .shadow(color: .black.opacity(0.35), radius: 24)
    } else {
      Text(line.text)
        .font(.system(size: 54, weight: .bold))
        .multilineTextAlignment(.center)
        .foregroundStyle(.white.opacity(role == .past ? 0.2 : 0.42))
        .lineLimit(2)
    }
  }
}

/// A word that fills with the accent colour as it's sung, then settles to cream.
struct WordView: View {
  let text: String
  let progress: Double

  var body: some View {
    Text(text)
      .foregroundStyle(progress >= 1 ? Theme.sung : .white.opacity(0.38))
      .overlay {
        if progress > 0 && progress < 1 {
          Text(text)
            .foregroundStyle(Theme.accent)
            .mask(alignment: .leading) {
              GeometryReader { geo in Rectangle().frame(width: geo.size.width * progress) }
            }
        }
      }
  }
}

struct CountIn: View {
  let seconds: Double
  let singer: String?

  var body: some View {
    VStack(spacing: 12) {
      if let singer {
        Text("\(singer), you’re up").font(.title2.weight(.semibold)).foregroundStyle(Theme.accent)
      }
      HStack(spacing: 22) {
        ForEach(0..<3) { beat in
          Circle()
            .fill(Theme.accent.opacity(Double(beat) < 3 - seconds.rounded(.up) + 1 ? 1 : 0.25))
            .frame(width: 22, height: 22)
        }
      }
    }
  }
}

struct NowPlaying: View {
  let session: SingSession

  var body: some View {
    HStack(spacing: 26) {
      Artwork(url: session.song.artwork)
        .frame(width: 84, height: 84)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      VStack(alignment: .leading, spacing: 4) {
        Text(session.song.track).font(.headline)
        Text(session.song.artist).font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      if session.status == .ready {
        Text(session.playing ? "◀ ▶  timing    ⏯  pause    Menu  back" : "Paused — ⏯ to resume")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
    }
    .lineLimit(1)
    .padding(.horizontal, 20)
    .padding(.bottom, 10)
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
