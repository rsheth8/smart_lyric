import SwiftUI
import Bar4BarCore

/// Settings, built from the app's own tokens.
///
/// This screen used to be a stock SwiftUI `Form`, which brought its own
/// grey-blue background and system row chrome — on a TV it read as if you had
/// left Bar4Bar and landed in tvOS Settings. Worse, `Form` renders a plain
/// `Text` as a row, so every explanatory paragraph looked like a button you
/// could press. Everything here is `TVGroup` / `TVActionRow` / `TVStepperRow`
/// instead, so the same focus language works throughout the app.
struct SettingsView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @EnvironmentObject private var spotify: SpotifyService
  @ObservedObject private var logs = TVLogStore.shared
  @Binding var path: NavigationPath
  @State private var stagePresented = false

  var body: some View {
    ZStack {
      Tokens.surface0.ignoresSafeArea()
      PosterEnvironment(letters: "B4", browsing: true)
        .opacity(0.22)

      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: Tokens.Space.s5) {
          header
          HStack(alignment: .top, spacing: Tokens.Space.s5) {
            stageInvitation.frame(maxWidth: .infinity, alignment: .leading)
            demoGroup.frame(maxWidth: .infinity)
          }
          sectionTitle("YOUR MUSIC", detail: "Choose where the recording plays.")
          HStack(alignment: .top, spacing: Tokens.Space.s5) {
            appleMusicGroup.frame(maxWidth: .infinity)
            if AppConfig.spotifyFollowEnabled { spotifyGroup.frame(maxWidth: .infinity) }
          }
          sectionTitle("SINGING TOOLS", detail: "Change the words without leaving the performance.")
          HStack(alignment: .top, spacing: Tokens.Space.s5) {
            timingGroup.frame(maxWidth: .infinity)
            lyricsGroup.frame(maxWidth: .infinity)
          }
          #if DEBUG
          logsGroup
          #endif
          aboutGroup
        }
        .padding(.vertical, Tokens.safeY)
        .padding(.bottom, 80)
      }
      .padding(.horizontal, Tokens.safeX)
    }
    .sheet(isPresented: $stagePresented) {
      StageSettingsPanel().environmentObject(session).environmentObject(music)
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      Text("Make the room yours.")
        .font(Tokens.editorial(68, italic: true))
      Spacer()
      BrandLockup(size: 28)
    }
    .foregroundStyle(Tokens.ink)
  }

  private var stageInvitation: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("01 / THE STAGE")
        .font(Tokens.caption(19)).tracking(3.5).foregroundStyle(Tokens.ember)
      Text("How should the room feel tonight?")
        .font(Tokens.editorial(49))
        .fixedSize(horizontal: false, vertical: true)
      Text("Choose the atmosphere, how far ahead to read, and who takes each line.")
        .font(Tokens.control(23)).foregroundStyle(Tokens.text2)
        .fixedSize(horizontal: false, vertical: true)
      Button("Shape the stage") { stagePresented = true }
        .buttonStyle(RoomButtonStyle(prominent: true))
    }
    .padding(.vertical, 24)
    .accessibilityElement(children: .contain)
  }

  private func sectionTitle(_ title: String, detail: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 22) {
      Text(title).font(Tokens.caption(19)).tracking(3.5).foregroundStyle(Tokens.ember)
      Text(detail).font(Tokens.control(22)).foregroundStyle(Tokens.text2)
    }
  }

  // MARK: - Demo

  private var demoGroup: some View {
    TVGroup(
      title: "Demo",
      footnote: "A 52-second visual preview. No song audio or account needed."
    ) {
      TVActionRow(
        title: music.isDemo ? "Back to the preview" : "Open the visual preview",
        subtitle: "\(DemoSong.title) · \(DemoSong.artist)",
        icon: "play.circle.fill",
        tint: Tokens.accentStatic
      ) {
        // Starting the demo used to leave you sitting on this screen: the
        // root's auto-push deliberately ignores demo tracks, so nothing
        // happened. Push the karaoke screen from here instead.
        if !music.isDemo { music.startDemo() }
        path.append(Route.karaoke)
      }

      if music.isDemo {
        Divider().overlay(Tokens.line1)
        TVActionRow(title: "Restart from the top", icon: "gobackward") {
          music.restartDemo()
          path.append(Route.karaoke)
        }
        Divider().overlay(Tokens.line1)
        TVActionRow(title: "Stop the demo", icon: "stop.circle", tint: Tokens.ember) {
          music.stopDemo()
          session.clear()
        }
      }
    }
  }

  // MARK: - Apple Music

  private var appleMusicGroup: some View {
    TVGroup(title: "Apple Music", footnote: appleMusicFootnote) {
      TVInfoRow(label: "Status", value: authLabel, tint: authTint)

      switch music.authStatus {
      case .authorized:
        Divider().overlay(Tokens.line1)
        TVActionRow(title: "Find a song", icon: "magnifyingglass") {
          path.append(Route.search)
        }
      case .denied, .restricted:
        // Re-asking cannot succeed once the answer is on record — tvOS returns
        // the stored decision without showing a prompt. Sending the viewer to
        // the right place is the only honest action left.
        EmptyView()
      default:
        Divider().overlay(Tokens.line1)
        TVActionRow(title: "Connect Apple Music", icon: "music.note", tint: Tokens.accentStatic) {
          Task { await music.requestAccess() }
        }
      }
    }
  }

  private var appleMusicFootnote: String {
    switch music.authStatus {
    case .denied:
      return "Access was declined. tvOS will not ask again from inside the app — turn Bar4Bar back on in Settings ▸ Apps ▸ Bar4Bar ▸ Media & Apple Music."
    case .restricted:
      return "Access to Apple Music is restricted on this Apple TV, most likely by Screen Time or a profile."
    case .authorized:
      return "Play a song in Music or from Bar4Bar — the words follow this Apple TV."
    default:
      return "Connecting lets Bar4Bar search the catalog, start playback, and follow whatever is already playing in Music."
    }
  }

  // MARK: - Timing

  private var timingGroup: some View {
    TVGroup(
      title: "Match the words",
      footnote: "If the words seem early or late, adjust the current song. The cue can also lead the voice slightly."
    ) {
      TVStepperRow(
        label: "Sync offset",
        value: String(format: "%+.2f s", session.syncOffset),
        hint: offsetHint,
        onDecrease: { session.nudgeSync(by: -0.05) },
        onIncrease: { session.nudgeSync(by: 0.05) }
      )
      Divider().overlay(Tokens.line1)
      TVActionRow(title: "Reset offset to zero", icon: "arrow.counterclockwise") {
        session.resetSync()
      }
      Divider().overlay(Tokens.line1)
      TVStepperRow(
        label: "Singer lead",
        value: String(format: "%.0f ms", session.singerLead * 1000),
        hint: "Cue the highlight this far ahead of the vocal",
        onDecrease: { session.setSingerLead(session.singerLead - 0.02) },
        onIncrease: { session.setSingerLead(session.singerLead + 0.02) }
      )
      Divider().overlay(Tokens.line1)
      TVActionRow(title: "Listen mode · 0 ms", icon: "headphones") {
        session.setSingerLead(DisplayMath.singerLeadListen)
      }
      Divider().overlay(Tokens.line1)
      TVActionRow(title: "Sing mode · 120 ms", icon: "mic") {
        session.setSingerLead(DisplayMath.singerLead)
      }
    }
  }

  /// Naming the track the offset belongs to matters: without it, an adjustment
  /// made here looks global when it is actually stored per song.
  private var offsetHint: String {
    guard let track = music.nowPlaying else {
      return "Start a song to adjust its timing"
    }
    if track.isDemo { return "Demo only — not saved" }
    return "Saved for “\(track.title)”"
  }

  // MARK: - Lyrics

  /// Spotify's home in Settings.
  ///
  /// The pairing screen can already disconnect, but nobody looks for a
  /// connected account on the screen they used to connect it — they look here,
  /// next to the other one.
  private var spotifyGroup: some View {
    TVGroup(
      title: "Spotify",
      footnote: "Pause and skip from the remote. Sound still plays on your phone or speaker — this TV cannot play Spotify audio."
    ) {
      TVInfoRow(
        label: "Status",
        value: spotify.isConnected ? "Connected" : "Not connected",
        tint: spotify.isConnected ? Tokens.ok : Tokens.text2
      )
      if spotify.isConnected {
        TVInfoRow(
          label: "Now following",
          value: spotify.track.map(\.title) ?? "Nothing playing",
          tint: Tokens.text2
        )
        TVInfoRow(
          label: "Next in queue",
          value: spotify.nextUp?.title ?? "Unknown yet",
          tint: Tokens.text2
        )
        TVActionRow(title: "Disconnect Spotify", icon: "xmark.circle", tint: Tokens.ember) {
          spotify.disconnect()
        }
      } else {
        TVActionRow(title: "Connect Spotify", icon: "dot.radiowaves.left.and.right") {
          path.append(Route.spotify)
        }
      }
    }
  }

  private var logsGroup: some View {
    TVGroup(
      title: "Recent logs",
      footnote: "Queue reads and next-song lyric fetches. The line you want on a track change is “installed prep”."
    ) {
      if logs.lines.isEmpty {
        TVInfoRow(label: "Log", value: "Play a playlist — lines show up here", tint: Tokens.text3)
      } else {
        ForEach(Array(logs.lines.suffix(8).reversed().enumerated()), id: \.offset) { _, line in
          Text(line)
            .font(Tokens.display(Tokens.FontSize.xs, .regular))
            .foregroundStyle(Tokens.text2)
            .fixedSize(horizontal: false, vertical: true)
          Divider().overlay(Tokens.line1)
        }
      }
    }
  }

  private var lyricsGroup: some View {
    TVGroup(
      title: "Words and language",
      footnote: "Reviewed and saved timings are more precise. Other songs keep approximate word guidance where available."
    ) {
      TVInfoRow(
        label: "Catalog policy",
        value: AppConfig.officialLyricsOnly ? "Licensed + reviewed only" : "Development coverage",
        tint: AppConfig.lyricsAPIBase == nil ? Tokens.text3 : Tokens.ok
      )
      if !AppConfig.officialLyricsOnly {
        Divider().overlay(Tokens.line1)
        TVInfoRow(label: "Fallback", value: "LRCLIB · line-level", tint: Tokens.text2)
      }
      Divider().overlay(Tokens.line1)
      TVActionRow(
        title: "Language aid",
        subtitle: session.preferredAidMode.label + " · pronunciation and English sit under the line, not beside it",
        icon: "globe"
      ) {
        Task { await session.cycleAid() }
      }
    }
  }

  // MARK: - About

  private var aboutGroup: some View {
    TVGroup(
      title: "About",
      footnote: "Cinematic synced lyrics for the moments when you know the song by heart. Timing quality varies by recording and is shown on the stage."
    ) {
      TVInfoRow(label: "Bar4Bar for Apple TV", value: versionString, tint: Tokens.text2)
    }
  }

  private var versionString: String {
    let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
    return "Version \(v) (\(b))"
  }

  // MARK: - Auth labels

  private var authLabel: String {
    switch music.authStatus {
    case .authorized: return "Connected"
    case .denied: return "Access declined"
    case .restricted: return "Restricted"
    case .notDetermined: return "Not connected"
    @unknown default: return "Unknown"
    }
  }

  private var authTint: Color {
    switch music.authStatus {
    case .authorized: return Tokens.ok
    case .denied, .restricted: return Tokens.ember
    default: return Tokens.text2
    }
  }
}
