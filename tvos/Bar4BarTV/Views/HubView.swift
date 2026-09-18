import SwiftUI
import MusicKit
import Bar4BarCore

/// A lyric-first home: experience, music source, then discovery.
/// Focus starts on a playable experience without opening the keyboard.
struct HubView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @EnvironmentObject private var spotify: SpotifyService
  @Binding var path: NavigationPath

  /// Where focus opens.
  ///
  /// `prefersDefaultFocus(in:)` does not survive a `ScrollView` — tvOS falls
  /// back to first-in-traversal, which here is the search field, the one
  /// control this screen deliberately does not want to open on. Driving it from
  /// `@FocusState` is the version that actually holds.
  private enum HubFocus: Hashable {
    case demoTile
    case card(String)
  }
  @FocusState private var focus: HubFocus?

  var body: some View {
    ZStack {
      PosterEnvironment(letters: "B4", browsing: true)

      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 42) {
          header
          hero
          sources
          messages

          if !music.recentSongs.isEmpty {
            shelf(
              title: "Play it again",
              items: music.recentSongs
            )
          }

          recommended
        }
        .padding(.horizontal, Tokens.safeX)
        .padding(.vertical, Tokens.safeY)
        .animation(Tokens.Motion.page, value: music.nowPlaying?.id)
        .animation(Tokens.Motion.page, value: music.chartSongs.count)
      }
    }
    .ignoresSafeArea()
    .task {
      if let mode = DemoLaunch.fakeResults {
        music.forceBrowseState(mode, term: "gold")
      }
      // One turn after the focus engine has made its own assignment, so ours is
      // the one that sticks. A returning viewer opens on what they played last;
      // a first-time viewer opens on the demo, which is the only thing on this
      // screen guaranteed to work before anything is connected.
      try? await Task.sleep(for: .milliseconds(120))
      focus = .demoTile
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(spacing: 36) {
      BrandLockup(size: 38)
      Rectangle().fill(Tokens.line2).frame(width: 1, height: 28)
      Text("EVERYONE HAS A WAY IN")
        .font(Tokens.display(17, .semibold)).tracking(3.5).foregroundStyle(Tokens.text2)
      Spacer()
      Button { path.append(Route.search) } label: { Label("Search", systemImage: "magnifyingglass") }
        .buttonStyle(RoomButtonStyle())
      Button { path.append(Route.settings) } label: { Label("Settings", systemImage: "slider.horizontal.3") }
        .buttonStyle(RoomButtonStyle())
    }
  }

  private var hero: some View {
    ZStack(alignment: .topTrailing) {
      Text("Bar4Bar").font(Tokens.editorial(250)).tracking(-14)
        .foregroundStyle(Tokens.ember.opacity(0.32)).rotationEffect(.degrees(-9))
        .offset(x: 175, y: -65).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 24) {
        Text("AN AFTER-DARK SINGING ROOM / 01")
          .font(Tokens.caption(18)).tracking(3).foregroundStyle(Tokens.lilac)
        Text("Your voice,\nin good company.")
          .font(Tokens.editorial(86, italic: true)).tracking(-2)
          .foregroundStyle(Tokens.text1).fixedSize(horizontal: false, vertical: true)
        Text(music.nowPlaying == nil
          ? "Take a verse. Share a hook. Make the room yours."
          : "Return to \(music.nowPlaying?.title ?? "your music").")
          .font(Tokens.control(25)).foregroundStyle(Tokens.text2)
        HStack(spacing: 22) {
          Button {
            if music.nowPlaying == nil { music.startDemo() }
            path.append(Route.karaoke)
          } label: {
            Label(music.nowPlaying == nil ? "Experience Bar4Bar" : "Back to the stage", systemImage: "play.fill")
          }.buttonStyle(RoomButtonStyle(prominent: true)).focused($focus, equals: .demoTile)
          Button("Find a song") { path.append(Route.search) }.buttonStyle(RoomButtonStyle())
        }.padding(.top, 12)
        if music.nowPlaying == nil {
          Text("52-second visual study · No sign-in needed")
            .font(Tokens.caption(18)).foregroundStyle(Tokens.text2)
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 40)
    }.frame(height: 500).clipped()
  }

  // MARK: - Sources

  private var sources: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Bring your music")
      HStack(spacing: Tokens.Space.s3) {
        SourceTile(
          icon: "music.note",
          title: appleMusicTitle,
          subtitle: appleMusicSubtitle,
          tint: Tokens.ember,
          connected: music.authStatus == .authorized
        ) {
          switch music.authStatus {
          case .authorized: path.append(Route.search)
          // Re-offering "Connect" after a denial is a button that cannot work:
          // tvOS returns the stored answer without prompting. Settings is the
          // only place that decision can actually change.
          case .denied, .restricted: path.append(Route.settings)
          default: Task { await music.requestAccess() }
          }
        }

        if AppConfig.spotifyFollowEnabled {
          SourceTile(
            icon: "dot.radiowaves.left.and.right",
            title: spotify.isConnected ? "Spotify" : "Connect Spotify",
            subtitle: spotifySubtitle,
            tint: Tokens.ok,
            connected: spotify.isConnected
          ) {
            path.append(Route.spotify)
          }
        }

      }
    }
  }

  private var spotifySubtitle: String {
    guard spotify.isConnected else { return "Play on your phone. See the words here." }
    guard let track = spotify.track else { return "Nothing playing right now" }
    if let next = spotify.nextUp {
      return "\(track.title) — next \(next.title)"
    }
    return "\(track.title) — \(track.artist)"
  }

  private var appleMusicTitle: String {
    switch music.authStatus {
    case .authorized: return "Apple Music"
    case .denied, .restricted: return "Apple Music is off"
    default: return "Connect Apple Music"
    }
  }

  private var appleMusicSubtitle: String {
    switch music.authStatus {
    case .authorized:
      if let track = music.nowPlaying, !track.isDemo, !music.isFollowing {
        return "\(track.title) — \(track.artist)"
      }
      return "Play here or follow the Music app"
    case .denied, .restricted: return "Turn it on in tvOS Settings"
    default: return "Play music directly on this Apple TV"
    }
  }

  // MARK: - Shelves

  private var recommended: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Find your next favorite", subtitle: "Apple Music")
      ScrollView(.horizontal) {
        HStack(spacing: Tokens.Space.s3) {
          if music.isLoadingCharts {
            // Six is what fits across 1080p, so the reserved space matches the
            // space the real cards will occupy and nothing shifts on arrival.
            ForEach(0..<6, id: \.self) { _ in SkeletonCard() }
          } else if music.chartSongs.isEmpty {
            Button("Reload songs") { Task { await music.loadCharts() } }
              .buttonStyle(TVPillStyle())
          } else {
            ForEach(music.chartSongs) { item in
              EditorialSongEntry(item: item, selected: focus == .card(item.id), compact: true) { start(item) }
            }
          }
        }
        .padding(.vertical, Tokens.Space.s3)
        .padding(.horizontal, 4)
      }
    }
  }

  private func shelf(title: String, items: [CatalogItem], defaultFocus: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader(title)
      ScrollView(.horizontal) {
        HStack(spacing: Tokens.Space.s3) {
          ForEach(items) { item in
            EditorialSongEntry(item: item, selected: focus == .card(item.id), compact: true) { start(item) }
              .focused($focus, equals: .card(item.id))
          }
        }
        .padding(.vertical, Tokens.Space.s3)
        .padding(.horizontal, 4)
      }
    }
  }

  /// Only navigate when playback actually started. Pushing the karaoke screen
  /// over silence — which is what happens when the song will not resolve, or
  /// Apple Music is not connected — is the dead end this guards.
  private func start(_ item: CatalogItem) {
    Task {
      if await music.play(item) {
        path.append(Route.karaoke)
      }
    }
  }

  // MARK: - Messages

  @ViewBuilder
  private var messages: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s2) {
      if let err = music.errorMessage {
        Label(err, systemImage: "exclamationmark.triangle.fill")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.error)
      }
      if let status = music.statusMessage {
        Text(status)
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text3)
      }
    }
  }
}

// MARK: - Search field

/// Looks like the web hub's search input, behaves like a button.
struct TVSearchFieldStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    FieldBody(configuration: configuration)
  }

  private struct FieldBody: View {
    let configuration: Configuration
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .foregroundStyle(focused ? Tokens.accentStatic : Tokens.text3)
        .padding(.horizontal, Tokens.Space.s4)
        .frame(height: 78)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .fill(focused ? Tokens.surface3 : Tokens.surface2)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .stroke(focused ? Tokens.accentStatic : Tokens.line2,
                    lineWidth: focused ? 2 : 1)
        )
        .scaleEffect(configuration.isPressed ? 0.995 : 1)
        .animation(Tokens.Motion.easeOut, value: focused)
    }
  }
}
