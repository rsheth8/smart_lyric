import SwiftUI
import Bar4BarCore

struct StageSettingsPanel: View {
  @EnvironmentObject private var session: LyricsSession
  @EnvironmentObject private var music: MusicPlayerService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || DemoLaunch.reduceMotion }
  private enum Control: String { case focus, live, headliner, preview, roles, demo, blank, loop, done }
  @FocusState private var focused: Control?
  @State private var previewStart = Date()
  @Namespace private var pickerScope
  @Environment(\.resetFocus) private var resetFocus

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        VStack(alignment: .leading, spacing: 8) {
          Text("Make the stage yours.").font(Tokens.editorial(62, italic: true))
          Text("Three ways to shape the room. Your words stay in place.")
            .font(Tokens.display(25, .medium)).foregroundStyle(Tokens.text2)
        }
        Spacer()
        Button("Done") { dismiss() }.buttonStyle(RoomButtonStyle()).accessibilityIdentifier("stageDone")
          .focused($focused, equals: .done).onMoveCommand { move($0, from: .done) }
      }
      preview.frame(height: 180).clipped()
      Text("ATMOSPHERE")
        .font(Tokens.caption(17)).tracking(3).foregroundStyle(Tokens.lilac)
      HStack(spacing: 22) {
        ForEach(Array(StageIntensity.allCases.enumerated()), id: \.element) { index, intensity in
          Button { session.intensity = intensity } label: {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(String(format: "STUDY %02d", index + 1))
                  .font(Tokens.caption(15)).tracking(2.3)
                Spacer()
                if session.intensity == intensity { Image(systemName: "checkmark.circle.fill") }
              }
              Text(intensity.rawValue.capitalized).font(Tokens.editorial(36))
              Text(description(intensity))
                .font(Tokens.display(18, .medium))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading).frame(height: 130)
          }
          .buttonStyle(ExhibitionStudyStyle())
          .focused($focused, equals: Control(rawValue: intensity.rawValue))
          .onMoveCommand { move($0, from: Control(rawValue: intensity.rawValue)!) }
          .accessibilityIdentifier("intensity-\(intensity.rawValue)")
        }
      }
      Text("SINGING")
        .font(Tokens.caption(17)).tracking(3).foregroundStyle(Tokens.lilac)
      HStack(spacing: 22) {
        Button {
          session.previewSeconds = session.previewSeconds < 2 ? 3 : session.previewSeconds < 4 ? 5 : 1.5
        } label: {
          Label("Read ahead: \(session.previewSeconds, specifier: "%.1f")s", systemImage: "arrow.right.to.line")
        }.buttonStyle(RoomButtonStyle()).accessibilityIdentifier("stagePreview")
          .focused($focused, equals: .preview).onMoveCommand { move($0, from: .preview) }
        Button {
          let roles = ["Solo", "Take turns", "Everyone"]
          session.partyMode = roles[((roles.firstIndex(of: session.partyMode) ?? 0) + 1) % roles.count]
        } label: {
          Label(session.partyMode == "Take turns" ? "Duo · Take turns" : session.partyMode,
            systemImage: "person.2")
        }.buttonStyle(RoomButtonStyle()).accessibilityIdentifier("stageRoles")
          .focused($focused, equals: .roles).onMoveCommand { move($0, from: .roles) }
        if music.isDemo {
          Button { session.setAutomaticDemo(!session.automaticDemo) } label: {
            Text(session.automaticDemo ? "Automatic demo" : "Featured demo")
          }.buttonStyle(RoomButtonStyle()).accessibilityIdentifier("stageDemoSource")
            .focused($focused, equals: .demo).onMoveCommand { move($0, from: .demo) }
        }
      }
      Text("PRACTICE")
        .font(Tokens.caption(17)).tracking(3).foregroundStyle(Tokens.lilac)
      HStack(spacing: 22) {
        let blankLabels = ["Blank off", "Every 2nd", "Every 3rd", "Every 4th"]
        let blankValues = [0, 2, 3, 4]
        let blankIdx = blankValues.firstIndex(of: session.blankNthWord) ?? 0
        Button {
          session.blankNthWord = blankValues[(blankIdx + 1) % blankValues.count]
        } label: {
          Label(blankLabels[blankIdx], systemImage: "eye.slash")
        }.buttonStyle(RoomButtonStyle()).accessibilityIdentifier("stageBlankWords")
          .focused($focused, equals: .blank).onMoveCommand { move($0, from: .blank) }
        Button {
          session.loopSection.toggle()
        } label: {
          Label(session.loopSection ? "Loop: on" : "Loop: off", systemImage: session.loopSection ? "repeat.1" : "repeat")
        }.buttonStyle(RoomButtonStyle(prominent: session.loopSection)).accessibilityIdentifier("stageLoopSection")
          .focused($focused, equals: .loop).onMoveCommand { move($0, from: .loop) }
      }
      Text(session.partyMode == "Take turns"
        ? "Side A and Side B alternate singable phrases. A handoff appears before the next voice."
        : session.partyMode == "Everyone" ? "Everyone sings together. No scores, just the room."
        : "Sing solo, or choose how the room joins in.")
        .font(Tokens.display(21, .medium)).foregroundStyle(Tokens.text2)
      Text("Adjust word timing and language separately from the playback deck.")
        .font(Tokens.display(18, .regular)).foregroundStyle(Tokens.text2)
    }
    .padding(56)
    .background(Tokens.surface0.ignoresSafeArea())
    .focusScope(pickerScope)
    .defaultFocus($focused, Control(rawValue: session.intensity.rawValue), priority: .userInitiated)
    .task {
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled else { return }
      focused = Control(rawValue: session.intensity.rawValue)
      resetFocus(in: pickerScope)
    }
    .onExitCommand { dismiss() }
  }

  private func move(_ direction: MoveCommandDirection, from control: Control) {
    let choices: [Control] = [.focus, .live, .headliner]
    let options: [Control] = music.isDemo ? [.preview, .roles, .demo] : [.preview, .roles]
    let practice: [Control] = [.blank, .loop]
    let row = choices.contains(control) ? choices : options.contains(control) ? options : practice
    if let index = row.firstIndex(of: control) {
      if direction == .left && index > 0 { focused = row[index - 1] }
      if direction == .right && index + 1 < row.count { focused = row[index + 1] }
    }
    if direction == .up {
      focused = choices.contains(control) ? .done : options.contains(control)
        ? Control(rawValue: session.intensity.rawValue) : .preview
    }
    if direction == .down {
      focused = control == .done ? Control(rawValue: session.intensity.rawValue)
        : choices.contains(control) ? .preview : options.contains(control) ? .blank : .done
    }
  }

  private var preview: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
      let t = context.date.timeIntervalSince(previewStart).truncatingRemainder(dividingBy: 8)
      let intensity = focused.flatMap { StageIntensity(rawValue: $0.rawValue) } ?? session.intensity
      ZStack {
        PosterEnvironment(state: previewState(t), intensity: intensity, reduceMotion: reduceMotion, letters: "MY")
        VStack(alignment: .leading, spacing: 14) {
          Text(t < 4 ? "VERSE / FIND YOUR FLOW" : "HOOK / BRING THE ROOM")
            .font(Tokens.display(16, .bold)).tracking(3).foregroundStyle(Tokens.ember)
          HStack(spacing: 15) {
            ForEach(Array(["Make", "this", "moment", "yours."].enumerated()), id: \.offset) { index, word in
              WordWipeView(word: LyricWord(text: word, start: Double(index) * 0.7, end: Double(index + 1) * 0.7),
                t: t.truncatingRemainder(dividingBy: 4), depth: .active, gapToNext: 0, typeSize: 70,
                fill: t < 4 ? Tokens.ember : Tokens.chartreuse,
                emphasis: index == 3 && t > 6.1 && t < 6.6 ? intensity.strength : 0,
                expressiveScale: intensity == .headliner)
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 85)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Animated verse and hook preview")
  }
  private func previewState(_ t: Double) -> StagePresentation {
    var result = StagePresentation()
    result.kind = t < 4 ? .verse : .chorus
    result.previousKind = t < 4 ? .chorus : .verse
    result.sectionTransition = min(1, t.truncatingRemainder(dividingBy: 4) / 0.7)
    result.motionTime = t
    return result
  }
  private func description(_ intensity: StageIntensity) -> String {
    switch intensity {
    case .focus: return "Still scene. Clear entrances."
    case .live: return "Phrases enter; the room responds."
    case .headliner: return "Bigger hooks. Words stay put."
    }
  }
}

/// Study descriptions need their full height; transport buttons use a shorter plate.
private struct ExhibitionStudyStyle: ButtonStyle {
  @Environment(\.isFocused) private var focused
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.padding(16)
      .foregroundStyle(focused ? Tokens.surfaceSolid1 : Tokens.text1)
      .background(focused ? Tokens.text1 : Tokens.surfaceSolid1, in: RoundedRectangle(cornerRadius: 8))
      .overlay(alignment: .bottom) {
        Rectangle().fill(focused ? Tokens.ember : Tokens.lilac.opacity(0.35)).frame(height: 3)
      }
      .opacity(configuration.isPressed ? 0.85 : 1)
  }
}
