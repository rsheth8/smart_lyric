import SwiftUI
import MusicKit
import Bar4BarCore

/// The 10-foot hub.
///
/// Composed to match the Electron hub row for row — brand lockup, search,
/// Continue, Follow what's playing, Recommended — because the two surfaces are
/// one product and the TV one had been reduced to two cards on an empty ground.
///
/// The thing that makes this screen work is that **none of its content needs
/// MusicKit**. Charts and search come from the public feeds in `CatalogClient`,
/// so the shelves fill with real artwork before anyone connects an account, in
/// the simulator, and for a viewer with no subscription at all.
///
/// Browse-first, keyboard-last: focus opens on something you can *press*, never
/// on the text field, because summoning the on-screen keyboard is the worst
/// thing a TV app can do on launch.
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
      AmbientBackdrop(accent: session.accent.glow)

      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          header
          searchBar

          if !music.recentSongs.isEmpty {
            shelf(
              title: "Continue",
              items: music.recentSongs,
              defaultFocus: true
            )
          }

          sources
          recommended
          messages
        }
        .padding(.horizontal, Tokens.safeX)
        .padding(.vertical, Tokens.safeY)
      }
    }
    .task {
      if let mode = DemoLaunch.fakeResults {
        music.forceBrowseState(mode, term: "gold")
      }
      // One turn after the focus engine has made its own assignment, so ours is
      // the one that sticks. A returning viewer opens on what they played last;
      // a first-time viewer opens on the demo, which is the only thing on this
      // screen guaranteed to work before anything is connected.
      try? await Task.sleep(for: .milliseconds(120))
      focus = music.recentSongs.first.map { .card($0.id) } ?? .demoTile
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .center, spacing: Tokens.Space.s3) {
      BrandMark()
      VStack(alignment: .leading, spacing: 2) {
        BrandLockup(size: Tokens.FontSize.xl)
        Text("Every bar. Every word. In sync.")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text2)
      }
      Spacer()
      HStack(spacing: Tokens.Space.s3) {
        if music.nowPlaying != nil {
          Button("Now Playing") { path.append(Route.karaoke) }
            .buttonStyle(TVPillStyle())
        }
        Button("Settings") { path.append(Route.settings) }
          .buttonStyle(TVPillStyle())
      }
    }
  }

  // MARK: - Search

  /// The hub's search entry, matching the web hub's inline field.
  ///
  /// This is a button rather than a live `TextField` on purpose: a focusable
  /// field on the hub is one accidental click away from the on-screen keyboard
  /// covering the whole screen, and the search screen has a field of its own
  /// that is the right place for it.
  private var searchBar: some View {
    Button {
      path.append(Route.search)
    } label: {
      HStack(spacing: Tokens.Space.s3) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: Tokens.FontSize.md, weight: .semibold))
        Text("Search songs…")
          .font(Tokens.display(Tokens.FontSize.md, .regular))
        Spacer()
      }
    }
    .buttonStyle(TVSearchFieldStyle())
  }

  // MARK: - Sources

  private var sources: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Follow what's playing")
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

        SourceTile(
          icon: "dot.radiowaves.left.and.right",
          title: spotify.isConnected ? "Spotify" : "Connect Spotify",
          subtitle: spotifySubtitle,
          tint: Tokens.ok,
          connected: spotify.isConnected
        ) {
          path.append(Route.spotify)
        }

        SourceTile(
          icon: "play.circle.fill",
          title: music.isDemo ? "Back to the demo" : "See it in action",
          subtitle: "50-second sample — no account"
        ) {
          if !music.isDemo { music.startDemo() }
          path.append(Route.karaoke)
        }
        .focused($focus, equals: .demoTile)
      }
    }
  }

  private var spotifySubtitle: String {
    guard spotify.isConnected else { return "Follow what's playing" }
    return spotify.track.map { "\($0.title) — \($0.artist)" } ?? "Nothing playing right now"
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
    case .authorized: return "Search and play the catalog"
    case .denied, .restricted: return "Turn it on in tvOS Settings"
    default: return "Authorize once to play songs"
    }
  }

  // MARK: - Shelves

  private var recommended: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Recommended", subtitle: "Top songs right now")
      ScrollView(.horizontal) {
        HStack(spacing: Tokens.Space.s3) {
          if music.chartSongs.isEmpty {
            // Six is what fits across 1080p, so the reserved space matches the
            // space the real cards will occupy and nothing shifts on arrival.
            ForEach(0..<6, id: \.self) { _ in SkeletonCard() }
          } else {
            ForEach(music.chartSongs) { item in
              PosterCard(item: item) { start(item) }
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
            PosterCard(item: item) { start(item) }
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
