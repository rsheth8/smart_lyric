import SwiftUI
import Bar4BarCore

/// Slow light, independent of lyric onsets and remote focus. Gradients are
/// feathered directly rather than repeatedly blurring a television-size image.
struct ListeningRoomBackdrop: View {
  var accent: Color = Tokens.accentStatic
  var intensity: Double = 1
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drift = false

  var body: some View {
    GeometryReader { geo in
      ZStack {
        Tokens.surface0
        RadialGradient(colors: [accent.opacity(0.28 * intensity), accent.opacity(0.07 * intensity), .clear],
                       center: .center, startRadius: 0, endRadius: geo.size.width * 0.59)
          .frame(width: geo.size.width * 1.4, height: geo.size.width * 1.4)
          .position(x: geo.size.width * (drift ? 0.23 : 0.15), y: geo.size.height * 0.12)
        RadialGradient(colors: [Color(hex: 0xB25B3D).opacity(0.13 * intensity), .clear],
                       center: .center, startRadius: 0, endRadius: geo.size.width * 0.52)
          .frame(width: geo.size.width * 1.3, height: geo.size.width * 1.3)
          .position(x: geo.size.width * (drift ? 0.9 : 0.8), y: geo.size.height * 0.96)
        LinearGradient(colors: [.black.opacity(0.02), .black.opacity(0.38)],
                       startPoint: .top, endPoint: .bottom)
      }
      .frame(width: geo.size.width, height: geo.size.height)
      .clipped()
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 22).repeatForever(autoreverses: true)) { drift = true }
    }
    .onChange(of: reduceMotion) { _, reduced in
      if reduced { withAnimation(nil) { drift = false } }
    }
  }
}

/// Original, vector album sleeve for the bundled demo and first-run invitation.
struct RoomSleeve: View {
  var side: CGFloat = 360

  var body: some View {
    ZStack {
      Color(hex: 0xDA633F)
      GeometryReader { geo in
        let w = geo.size.width
        ZStack {
          ForEach(0..<9, id: \.self) { index in
            Circle()
              .stroke(Color(hex: 0x371F26).opacity(0.83), lineWidth: w * 0.035)
              .frame(width: w * (0.34 + Double(index) * 0.16))
          }
          Circle().fill(Color(hex: 0xF6DCAF)).frame(width: w * 0.1)
        }
        .position(x: w * 0.76, y: w * 0.57)
      }
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("BAR4BAR ORIGINAL")
          Spacer()
          Text("VOL. 01")
        }
        .font(Tokens.display(side * 0.026, .bold))
        .tracking(side * 0.004)
        Spacer()
        Text("BAR\nFOR BAR")
          .font(Tokens.editorial(side * 0.18))
          .tracking(-side * 0.008)
          .lineSpacing(-side * 0.015)
        Text("A ROOM FULL OF WORDS")
          .font(Tokens.display(side * 0.025, .semibold))
          .tracking(side * 0.004)
          .padding(.top, side * 0.03)
      }
      .padding(side * 0.075)
      .foregroundStyle(Color(hex: 0xFFF2D6))
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.16), lineWidth: 1))
    .accessibilityLabel("Bar for Bar, original demo artwork")
  }
}

/// A label stays visible even before a remote moves onto the control.
struct RoomButtonStyle: ButtonStyle {
  var prominent = false
  func makeBody(configuration: Configuration) -> some View {
    RoomButtonBody(configuration: configuration, prominent: prominent)
  }
  private struct RoomButtonBody: View {
    let configuration: Configuration
    let prominent: Bool
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
      configuration.label
        .font(Tokens.display(24, .semibold))
        .foregroundStyle(focused ? Color(hex: 0x16181C) : (prominent ? Tokens.accentInk : Tokens.text1))
        .padding(.horizontal, 26)
        .frame(height: 66)
        .background(focused ? Tokens.text1 : (prominent ? Tokens.accentStatic : Color.white.opacity(0.07)),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(focused ? .white : .white.opacity(0.08), lineWidth: focused ? 2 : 1))
        .scaleEffect(configuration.isPressed ? 0.97 : (focused && !reduceMotion ? 1.025 : 1))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: focused)
    }
  }
}

/// Only the lyric field ticks at display cadence. Artwork, menus and focus
/// controls never become children of the lyric clock.
struct RoomLyrics: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var immersive: Bool

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: !music.isPlaying)) { _ in
      let t = music.liveTime + session.syncOffset + session.singerLead
      let lines = session.timeline.lines
      if !lines.isEmpty {
        let active = DisplayMath.resolveActiveLine(lines, t: t)
        let gap = DisplayMath.gapState(lines: lines, t: t, activeLi: active)
        let anchor = max(0, min(lines.count - 1, gap.instrumental ? active + 1 : active))
        let lower = max(0, anchor - 2)
        let upper = min(lines.count - 1, anchor + 2)
        VStack(alignment: .leading, spacing: 16) {
          HStack(spacing: 12) {
            Capsule().fill(session.accent.accent).frame(width: 24, height: 3)
            Text(cueLabel(t: t, gap: gap))
              .font(Tokens.display(19, .semibold))
              .tracking(3)
              .foregroundStyle(session.accent.soft)
          }
          .frame(height: 28)
          .padding(.leading, 4)
          .accessibilityHidden(true)

          RoomLyricLayout(activeSlot: anchor - lower) {
            ForEach(lower...upper, id: \.self) { index in
              let isActive = index == active && !gap.instrumental
              let depth: LineDepth = isActive ? .active : (index < anchor ? .past : .next)
              LyricLineView(
                line: lines[index], t: t, depth: depth, accent: session.accent,
                wordTiming: session.timeline.hasWordTiming,
                aidText: index == anchor ? aid(for: lines[index]) : nil,
                aidMode: session.aidMode,
                listen: session.performanceMode == .listen,
                typeSize: KaraokeLayout.typeSize(immersive: immersive, characters: lines[index].text.count),
                leading: true
              )
              .opacity(index == anchor ? 1 : (index < anchor ? 0.25 : 0.57))
              .scaleEffect(index == anchor ? 1 : 0.83, anchor: .leading)
            }
          }
          .animation(reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.62), value: anchor)
          .mask {
            LinearGradient(stops: [
              .init(color: .clear, location: 0), .init(color: .white, location: 0.15),
              .init(color: .white, location: 0.75), .init(color: .clear, location: 1)
            ], startPoint: .top, endPoint: .bottom)
          }
        }
      }
    }
    .allowsHitTesting(false)
  }

  private func cueLabel(t: Double, gap: DisplayMath.GapState) -> String {
    if let seconds = gap.nextVocalIn, gap.instrumental {
      return seconds > 0 ? "BACK IN \(Int(ceil(seconds)))s" : "INSTRUMENTAL"
    }
    return (session.sectionLabel(at: t) ?? "LYRICS").uppercased()
  }

  private func aid(for line: LyricLine) -> String? {
    switch session.aidMode {
    case .off: return nil
    case .roman: return line.roman
    case .english: return line.english
    }
  }
}

/// Measured rows share a fixed focal point, including long and translated lines.
private struct RoomLyricLayout: Layout {
  let activeSlot: Int
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    CGSize(width: proposal.width ?? 1200, height: proposal.height ?? 600)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil)) }
    guard sizes.indices.contains(activeSlot) else { return }
    let spacing: CGFloat = 46
    let before = sizes.prefix(activeSlot).reduce(CGFloat.zero) { $0 + $1.height + spacing }
    var y = bounds.minY + bounds.height * 0.43 - sizes[activeSlot].height / 2 - before
    for (index, view) in subviews.enumerated() {
      view.place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading,
                 proposal: ProposedViewSize(width: bounds.width, height: sizes[index].height))
      y += sizes[index].height + spacing
    }
  }
}

/// The sleeve's circular motif becomes a quiet etched backdrop on the stage.
/// It has no timer, brightness pulses or relationship to inferred audio beats.
struct RecordEtching: View {
  var accent: Color
  var body: some View {
    Canvas { context, size in
      let center = CGPoint(x: size.width * 0.96, y: size.height * 0.48)
      for index in 0..<15 {
        let radius = CGFloat(150 + index * 33)
        let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        context.stroke(Path(ellipseIn: rect), with: .color(accent.opacity(index % 4 == 0 ? 0.11 : 0.045)), lineWidth: 1)
      }
    }
    .mask(LinearGradient(colors: [.clear, .clear, .white], startPoint: .leading, endPoint: .trailing))
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
