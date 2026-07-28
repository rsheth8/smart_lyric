import SwiftUI
import MusicKit
import Bar4BarCore

/// Catalog search.
///
/// The screen has four genuinely different states — never searched, searching,
/// found nothing, failed — and the first version rendered three of them as the
/// same line of grey text while `music.errorMessage` was never shown at all. A
/// search that quietly fails is worse than one that says so, because the viewer
/// retypes the same query from across the room.
struct SearchView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @Binding var path: NavigationPath
  @State private var query = ""
  @FocusState private var fieldFocused: Bool

  var body: some View {
    ZStack {
      AmbientBackdrop(intensity: 0.5)

      VStack(alignment: .leading, spacing: Tokens.Space.s5) {
        header

        if music.authStatus == .authorized || DemoLaunch.fakeResults != nil {
          searchBar
          results
        } else {
          connectGate
        }

        Spacer(minLength: 0)
      }
      .padding(.horizontal, Tokens.safeX)
      .padding(.vertical, Tokens.safeY)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .task {
      if let mode = DemoLaunch.fakeResults {
        music.loadPlaceholderResults(term: "gold", mode: mode)
      }
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .lastTextBaseline) {
      VStack(alignment: .leading, spacing: Tokens.Space.s1) {
        Text("Find a song")
          .font(Tokens.display(Tokens.FontSize.xxl, .bold))
          .foregroundStyle(Tokens.text1)
        Text("Apple Music catalog · press Menu to go back")
          .font(Tokens.display(Tokens.FontSize.base, .regular))
          .foregroundStyle(Tokens.text3)
      }
      Spacer()
      if let term = music.lastSearchTerm, !music.searchResults.isEmpty {
        Text("\(music.searchResults.count) results for “\(term)”")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text2)
      }
    }
  }

  // MARK: - Search bar

  private var searchBar: some View {
    HStack(spacing: Tokens.Space.s3) {
      // tvOS draws its own light plate on a focused text field, so an icon
      // placed beside it floats outside the control and reads as a stray
      // glyph. The magnifier belongs on the button, which we do draw.
      TextField("Song or artist", text: $query)
        .textFieldStyle(.plain)
        .font(Tokens.display(Tokens.FontSize.md, .medium))
        .focused($fieldFocused)
        .submitLabel(.search)
        .onSubmit { runSearch() }
        .frame(maxWidth: 820)

      Button {
        runSearch()
      } label: {
        Label("Search", systemImage: "magnifyingglass")
      }
      .buttonStyle(TVPillStyle())
      .disabled(query.trimmingCharacters(in: .whitespaces).isEmpty)
    }
  }

  private func runSearch() {
    fieldFocused = false
    Task { await music.search(query) }
  }

  // MARK: - Results

  @ViewBuilder
  private var results: some View {
    if music.isSearching {
      statusBlock(icon: nil, title: "Searching…", detail: nil, spinner: true)
    } else if let err = music.errorMessage {
      statusBlock(
        icon: "exclamationmark.triangle.fill",
        title: "That search didn't go through",
        detail: err,
        tint: Tokens.ember
      )
    } else if music.searchResults.isEmpty {
      if let term = music.lastSearchTerm {
        statusBlock(
          icon: "questionmark.circle",
          title: "Nothing matched “\(term)”",
          detail: "Try the artist's name, or fewer words."
        )
      } else {
        emptyGuidance
      }
    } else {
      grid(music.searchResults)
    }
  }

  private func grid(_ songs: [SongItem]) -> some View {
    ScrollView(.vertical) {
      LazyVGrid(
        columns: Array(
          repeating: GridItem(.fixed(Tokens.cardW), spacing: Tokens.Space.s4),
          count: 5
        ),
        alignment: .leading,
        spacing: Tokens.Space.s4
      ) {
        ForEach(songs) { song in
          SongCard(song: song) { start(song) }
        }
      }
      // Focus lifts and scales cards; without room they clip against the
      // scroll view's bounds.
      .padding(.vertical, Tokens.Space.s3)
      .padding(.horizontal, 6)
    }
  }

  private func start(_ song: SongItem) {
    Task {
      await music.play(song)
      // Pushing from here rather than relying on the root's auto-push: that
      // guard requires a loaded timeline, which never exists this early, so
      // choosing a song used to drop you back on the hub with nothing playing
      // on screen. The karaoke view has its own "fetching lyrics" state.
      if music.errorMessage == nil {
        path.append(Route.karaoke)
      }
    }
  }

  // MARK: - States

  private var emptyGuidance: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s5) {
      statusBlock(
        icon: "text.magnifyingglass",
        title: "Search the catalog",
        detail: "Type a song or artist above, then press Search. Anything you play here shows up on the hub afterwards."
      )

      if !music.recentSongs.isEmpty {
        VStack(alignment: .leading, spacing: Tokens.Space.s3) {
          Text("Recently played")
            .font(Tokens.display(Tokens.FontSize.md, .semibold))
            .foregroundStyle(Tokens.text1)
          ScrollView(.horizontal) {
            HStack(spacing: Tokens.Space.s4) {
              ForEach(music.recentSongs) { song in
                SongCard(song: song) { start(song) }
              }
            }
            .padding(.vertical, Tokens.Space.s3)
            .padding(.horizontal, 6)
          }
        }
      }
    }
  }

  /// Not authorized. This used to be a bare explanation with nothing to press —
  /// a screen that names the fix and then refuses to perform it.
  private var connectGate: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      statusBlock(
        icon: "music.note",
        title: gateTitle,
        detail: gateDetail,
        tint: Tokens.ember
      )
      HStack(spacing: Tokens.Space.s3) {
        if music.authStatus == .notDetermined {
          Button("Connect Apple Music") { Task { await music.requestAccess() } }
            .buttonStyle(TVPillStyle())
        }
        Button("Play the demo instead") {
          if !music.isDemo { music.startDemo() }
          path.append(Route.karaoke)
        }
        .buttonStyle(TVPillStyle())
      }
    }
  }

  private var gateTitle: String {
    music.authStatus == .notDetermined
      ? "Connect Apple Music to search"
      : "Apple Music is turned off for Bar4Bar"
  }

  private var gateDetail: String {
    switch music.authStatus {
    case .denied:
      return "tvOS will not ask again from inside the app. Turn Bar4Bar back on in Settings ▸ Apps ▸ Bar4Bar ▸ Media & Apple Music. The bundled demo works either way."
    case .restricted:
      return "Apple Music access is restricted on this Apple TV, most likely by Screen Time or a profile. The bundled demo works either way."
    default:
      return "Searching the catalog needs an Apple Music subscription on this Apple TV. The bundled demo works without one."
    }
  }

  private func statusBlock(
    icon: String?,
    title: String,
    detail: String?,
    tint: Color = Tokens.text2,
    spinner: Bool = false
  ) -> some View {
    HStack(alignment: .top, spacing: Tokens.Space.s3) {
      if spinner {
        ProgressView()
          .tint(Tokens.accentStatic)
          .scaleEffect(1.4)
          .frame(width: 44, height: 44)
      } else if let icon {
        Image(systemName: icon)
          .font(.system(size: Tokens.FontSize.lg))
          .foregroundStyle(tint)
          .frame(width: 44, height: 44)
      }
      VStack(alignment: .leading, spacing: Tokens.Space.s1) {
        Text(title)
          .font(Tokens.display(Tokens.FontSize.md, .semibold))
          .foregroundStyle(Tokens.text1)
        if let detail {
          Text(detail)
            .font(Tokens.display(Tokens.FontSize.base, .regular))
            .foregroundStyle(Tokens.text2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(Tokens.Space.s4)
    .frame(maxWidth: 1100, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
        .fill(Tokens.surface1)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
        .stroke(Tokens.line1, lineWidth: 1)
    )
  }
}
