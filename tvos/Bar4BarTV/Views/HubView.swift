import SwiftUI
import MusicKit
import Bar4BarCore

/// The 10-foot hub.
///
/// Browse-first, keyboard-last: the first thing focus lands on is something you
/// can *press*, never a text field, because summoning the on-screen keyboard is
/// the worst thing a TV app can do on launch.
struct HubView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath

  @Namespace private var hubNamespace

  var body: some View {
    ZStack {
      AmbientBackdrop()

      GeometryReader { proxy in
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: Tokens.Space.s6) {
            header
            primaryActions

            if !music.recentSongs.isEmpty {
              shelf(title: "Recently played", items: music.recentSongs)
            }

            messages
          }
          .padding(.horizontal, Tokens.safeX)
          .padding(.vertical, Tokens.safeY)
          // Centre the hub while it is short (the common case before anything
          // is connected) and let it scroll normally once shelves fill it in.
          .frame(
            maxWidth: .infinity,
            minHeight: proxy.size.height,
            alignment: .leading
          )
        }
      }
    }
    .task {
      if let mode = DemoLaunch.fakeResults {
        music.loadPlaceholderResults(term: "gold", mode: mode)
      }
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: Tokens.Space.s2) {
        BrandLockup()
        Text("Every bar. Every word. In sync.")
          .font(Tokens.display(Tokens.FontSize.lg, .medium))
          .foregroundStyle(Tokens.text2)
      }
      Spacer()
      HStack(spacing: Tokens.Space.s3) {
        Button("Search") { path.append(Route.search) }
          .buttonStyle(TVPillStyle())
        if music.nowPlaying != nil {
          Button("Now Playing") { path.append(Route.karaoke) }
            .buttonStyle(TVPillStyle())
        }
        Button("Settings") { path.append(Route.settings) }
          .buttonStyle(TVPillStyle())
      }
    }
  }

  // MARK: - Primary actions

  private var primaryActions: some View {
    HStack(alignment: .top, spacing: Tokens.Space.s4) {
      demoCard
        .prefersDefaultFocus(in: hubNamespace)
      switch music.authStatus {
      case .authorized: searchCard
      case .denied, .restricted: blockedCard
      default: connectCard
      }
    }
    .focusScope(hubNamespace)
  }

  /// The demo is a first-class entry, not a debug affordance: it is the only
  /// thing on this screen that works before you have connected anything, and
  /// it is what someone sees when deciding whether the app is for them.
  private var demoCard: some View {
    Button {
      if !music.isDemo { music.startDemo() }
      path.append(Route.karaoke)
    } label: {
      VStack(alignment: .leading, spacing: Tokens.Space.s3) {
        HStack(spacing: Tokens.Space.s2) {
          Image(systemName: "play.circle.fill")
            .font(.system(size: Tokens.FontSize.lg))
            .foregroundStyle(Tokens.accentStatic)
          Text(music.isDemo ? "Back to the demo" : "See it in action")
            .font(Tokens.display(Tokens.FontSize.xl, .bold))
            .foregroundStyle(Tokens.text1)
        }
        Text("A 50-second demo of word-by-word timing — held notes, a duet line, and the count-in. No subscription needed.")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .buttonStyle(TVActionCardStyle())
    .frame(maxWidth: .infinity)
  }

  private var connectCard: some View {
    Button {
      Task { await music.requestAccess() }
    } label: {
      VStack(alignment: .leading, spacing: Tokens.Space.s3) {
        HStack(spacing: Tokens.Space.s2) {
          Image(systemName: "music.note")
            .font(.system(size: Tokens.FontSize.lg))
            .foregroundStyle(Tokens.ember)
          Text("Connect Apple Music")
            .font(Tokens.display(Tokens.FontSize.xl, .bold))
            .foregroundStyle(Tokens.text1)
        }
        Text("Authorize once — then search, play, and follow word-by-word lyrics from the couch.")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .buttonStyle(TVActionCardStyle(accent: Tokens.ember))
    .frame(maxWidth: .infinity)
  }

  /// Authorization was declined or is restricted. Offering "Connect" again
  /// would be a button that cannot work — tvOS returns the stored answer
  /// without prompting — so this points at the only place that can change it.
  private var blockedCard: some View {
    Button {
      path.append(Route.settings)
    } label: {
      VStack(alignment: .leading, spacing: Tokens.Space.s3) {
        HStack(spacing: Tokens.Space.s2) {
          Image(systemName: "lock.fill")
            .font(.system(size: Tokens.FontSize.lg))
            .foregroundStyle(Tokens.ember)
          Text("Apple Music is off")
            .font(Tokens.display(Tokens.FontSize.xl, .bold))
            .foregroundStyle(Tokens.text1)
        }
        Text("Turn it back on in Settings ▸ Apps ▸ Bar4Bar. The demo works either way.")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .buttonStyle(TVActionCardStyle(accent: Tokens.ember))
    .frame(maxWidth: .infinity)
  }

  private var searchCard: some View {
    Button {
      path.append(Route.search)
    } label: {
      VStack(alignment: .leading, spacing: Tokens.Space.s3) {
        HStack(spacing: Tokens.Space.s2) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: Tokens.FontSize.lg))
            .foregroundStyle(Tokens.accentStatic)
          Text("Find a song")
            .font(Tokens.display(Tokens.FontSize.xl, .bold))
            .foregroundStyle(Tokens.text1)
        }
        Text("Search the Apple Music catalog and start singing.")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .buttonStyle(TVActionCardStyle())
    .frame(maxWidth: .infinity)
  }

  // MARK: - Shelves

  private func shelf(title: String, items: [SongItem]) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      Text(title)
        .font(Tokens.display(Tokens.FontSize.md, .semibold))
        .foregroundStyle(Tokens.text1)

      ScrollView(.horizontal) {
        HStack(spacing: Tokens.Space.s4) {
          ForEach(items) { song in
            SongCard(song: song) {
              Task {
                await music.play(song)
                path.append(Route.karaoke)
              }
            }
          }
        }
        .padding(.vertical, Tokens.Space.s3)
        .padding(.horizontal, 4)
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

// MARK: - Song card

struct SongCard: View {
  let song: SongItem
  let onPlay: () -> Void

  var body: some View {
    Button(action: onPlay) {
      VStack(alignment: .leading, spacing: Tokens.Space.s2) {
        artwork
          .frame(width: Tokens.cardW, height: Tokens.cardW)
          .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous))
        Text(song.title)
          .font(Tokens.display(Tokens.FontSize.base, .semibold))
          .foregroundStyle(Tokens.text1)
          .lineLimit(1)
          .frame(width: Tokens.cardW, alignment: .leading)
        Text(song.artist)
          .font(Tokens.display(Tokens.FontSize.sm, .regular))
          .foregroundStyle(Tokens.text2)
          .lineLimit(1)
          .frame(width: Tokens.cardW, alignment: .leading)
      }
    }
    .buttonStyle(TVPosterStyle())
  }

  @ViewBuilder
  private var artwork: some View {
    if let url = song.artworkURL {
      AsyncImage(url: url) { phase in
        switch phase {
        case .success(let image): image.resizable().scaledToFill()
        default: placeholder
        }
      }
    } else {
      placeholder
    }
  }

  private var placeholder: some View {
    RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
      .fill(Tokens.surface2)
      .overlay {
        Image(systemName: "music.note")
          .font(.system(size: Tokens.FontSize.xl))
          .foregroundStyle(Tokens.accentStatic.opacity(0.6))
      }
  }
}
