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

  var body: some View {
    ZStack {
      AmbientBackdrop(intensity: 0.5)

      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: Tokens.Space.s5) {
          header

          // Two columns rather than one long scroll: five groups stacked
          // vertically run well past 1080p, and a settings page you have to
          // scroll to discover is a settings page whose options go unfound.
          HStack(alignment: .top, spacing: Tokens.Space.s5) {
            VStack(alignment: .leading, spacing: Tokens.Space.s5) {
              demoGroup
              timingGroup
            }
            VStack(alignment: .leading, spacing: Tokens.Space.s5) {
              appleMusicGroup
              if AppConfig.spotifyFollowEnabled { spotifyGroup }
              lyricsGroup
              #if DEBUG
              logsGroup
              #endif
              aboutGroup
            }
          }
        }
        .padding(.vertical, Tokens.safeY)
      }
      .padding(.horizontal, Tokens.safeX)
    }
  }

  // MARK: - Header

  private var header: some View {
    TVPageHeading(title: "Settings", subtitle: "Make yourself at home.")
  }

  // MARK: - Demo

  private var demoGroup: some View {
    TVGroup(
      title: "Demo",
      footnote: "Explore the lyric stage with a 52-second visual demo. No account needed."
    ) {
      TVActionRow(
        title: music.isDemo ? "Back to the demo" : "Play the demo track",
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
      title: "Timing",
      footnote: "Sync offset is remembered per song. Sing is the default: the wipe arms 120 ms early so you can start on the beat. Listen lights the word with the recording — toggle it on the stage."
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
      title: "Lyrics source",
      footnote: "Lyrics are matched automatically. Word timing follows the singer when available; other songs highlight line by line."
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
