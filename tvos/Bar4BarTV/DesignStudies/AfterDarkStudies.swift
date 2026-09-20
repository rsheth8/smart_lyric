#if DEBUG
import SwiftUI
import Bar4BarCore

/// Native, vector-only composition studies. They are deliberately independent
/// of network and playback state so the six visual decisions can be reviewed
/// together in Xcode before changing the shared screen implementation.
private enum Study: String {
  case home, selection, settings, verse, hook, handoff

  var caption: String {
    switch self {
    case .home: return "01 / INVITATION"
    case .selection: return "02 / DISCOVERY"
    case .settings: return "03 / PREPARATION"
    case .verse: return "04 / VERSE"
    case .hook: return "05 / HOOK"
    case .handoff: return "06 / HANDOFF"
    }
  }

  var state: StagePresentation {
    var value = StagePresentation()
    value.kind = self == .hook ? .chorus : .verse
    value.previousKind = .verse
    value.sectionTransition = 1
    return value
  }
}

private struct AfterDarkStudy: View {
  let study: Study

  var body: some View {
    ZStack {
      PosterEnvironment(state: study.state, intensity: .live,
        letters: study == .selection ? "SS" : "B4", browsing: study == .home || study == .selection)
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("BAR4BAR")
            .font(Tokens.editorial(32))
          Spacer()
          Text(study.caption)
            .font(Tokens.caption(18)).tracking(3)
            .foregroundStyle(Tokens.ember)
        }
        Spacer()
        content
        Spacer()
        Text("AN AFTER-DARK TYPOGRAPHIC INSTALLATION")
          .font(Tokens.caption(17)).tracking(2.8)
          .foregroundStyle(Tokens.text2)
      }
      .foregroundStyle(Tokens.ink)
      .padding(.horizontal, 110)
      .padding(.vertical, 72)
    }
    .frame(width: 1920, height: 1080)
  }

  @ViewBuilder private var content: some View {
    switch study {
    case .home:
      VStack(alignment: .leading, spacing: 34) {
        Text("Your voice,\nin good company.")
          .font(Tokens.editorial(100, italic: true))
        Text("Find a song     /     Explore the visual stage")
          .font(Tokens.control(28))
          .foregroundStyle(Tokens.text2)
      }
    case .selection:
      VStack(alignment: .leading, spacing: 28) {
        Text("Find a song.").font(Tokens.editorial(84))
        ForEach(["Every bar lands right where it's told", "Your voice, in good company", "One word, then another"], id: \.self) { title in
          HStack(spacing: 28) {
            Rectangle().fill(Tokens.ember.opacity(0.68)).frame(width: 96, height: 96)
            Text(title).font(Tokens.editorial(37))
            Spacer()
            Text("WORD GUIDANCE").font(Tokens.caption(17)).tracking(2)
          }
          .padding(20)
          .background(Tokens.surfaceSolid2.opacity(0.94), in: RoundedRectangle(cornerRadius: 12))
        }
      }
    case .settings:
      HStack(alignment: .top, spacing: 80) {
        VStack(alignment: .leading, spacing: 24) {
          Text("Make the room yours.").font(Tokens.editorial(80, italic: true))
          Text("Atmosphere · read-ahead · singer roles")
            .font(Tokens.control(30)).foregroundStyle(Tokens.text2)
        }.frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 22) {
          ForEach(["FOCUS / STILL SCENE", "LIVE / EXPRESSIVE PHRASES", "HEADLINER / BIGGER HOOKS"], id: \.self) { title in
            Text(title).font(Tokens.caption(23)).tracking(1.4)
              .padding(25).frame(maxWidth: .infinity, alignment: .leading)
              .background(Tokens.surfaceSolid2, in: RoundedRectangle(cornerRadius: 10))
          }
        }.frame(maxWidth: .infinity)
      }
    case .verse, .hook, .handoff:
      VStack(spacing: 45) {
        Text(study == .hook ? "CHORUS / EVERYONE" : study == .handoff ? "SIDE B / YOUR TURN NEXT" : "VERSE / SOLO")
          .font(Tokens.caption(21)).tracking(3.5)
          .foregroundStyle(study == .hook ? Tokens.chartreuse : Tokens.ember)
        Text(study == .handoff ? "And I'll take\nthe harmony" : study == .hook ? "Every bar lands right\nwhere it's told" : "Nothing rushed and nothing late")
          .font(Tokens.lyric(84))
          .multilineTextAlignment(.center)
        VStack(spacing: 14) {
          Text("UP NEXT").font(Tokens.caption(17)).tracking(3).foregroundStyle(Tokens.lilac)
          Text(study == .hook ? "Sing it back, sing it together" : "Hold it here")
            .font(Tokens.lyric(39))
        }
        .padding(.top, 40)
      }
      .frame(maxWidth: .infinity)
    }
  }
}

#Preview("01 · Home") { AfterDarkStudy(study: .home) }
#Preview("02 · Song selection") { AfterDarkStudy(study: .selection) }
#Preview("03 · Settings") { AfterDarkStudy(study: .settings) }
#Preview("04 · Verse") { AfterDarkStudy(study: .verse) }
#Preview("05 · Hook") { AfterDarkStudy(study: .hook) }
#Preview("06 · Singer handoff") { AfterDarkStudy(study: .handoff) }
#endif
