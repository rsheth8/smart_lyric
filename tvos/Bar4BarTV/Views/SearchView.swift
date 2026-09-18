import SwiftUI
import MusicKit
import Bar4BarCore

/// Catalog search.
///
/// Search runs against the public iTunes catalog, so this screen works with no
/// account connected and inside the simulator. It used to sit behind an Apple
/// Music gate, which meant the one screen whose entire job is *finding
/// something* refused to do it until you had authorized — and then rendered
/// nothing at all anywhere MusicKit will not run.
///
/// Four genuinely different states — never searched, searching, found nothing,
/// failed — each with its own composition. A search that quietly fails is worse
/// than one that says so, because the viewer retypes the same query from across
/// the room.
struct SearchView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath
  @State private var query = ""

  /// Same story as the hub: `prefersDefaultFocus` does not survive a
  /// `ScrollView`, so focus is placed explicitly.
  ///
  /// The rule is about intent. Arriving with nothing typed, you came here to
  /// type, so the field takes focus. Arriving to results — or coming back from
  /// the keyboard — you came to pick, so the first card takes it. Leaving focus
  /// on the field in that second case also parks tvOS's light focused-field
  /// plate in the middle of a dark screen full of artwork.
  private enum SearchFocus: Hashable {
    case field
    case card(String)
  }
  @FocusState private var focus: SearchFocus?

  var body: some View {
    ZStack {
      PosterEnvironment(letters: InstallationForms.initials(focusedTitle), browsing: true)

      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        header
        searchBar
        results
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Tokens.safeX)
      .padding(.vertical, Tokens.safeY)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .animation(Tokens.Motion.page, value: music.searchResults.count)
      .animation(Tokens.Motion.page, value: music.isSearching)
    }
    .task {
      if DemoLaunch.browseFixture {
        music.forceBrowseState("fixture", term: "Original visual studies")
      } else if let mode = DemoLaunch.fakeResults {
        music.forceBrowseState(mode, term: "gold")
      } else if let term = DemoLaunch.searchTerm {
        query = term
        await music.search(term)
      }
      try? await Task.sleep(for: .milliseconds(120))
      focus = music.searchResults.first.map { .card($0.id) } ?? .field
    }
  }

  private var focusedTitle: String {
    guard case let .card(id) = focus else { return "Find songs" }
    return (music.searchResults + music.recentSongs + music.chartSongs).first(where: { $0.id == id })?.title ?? "Find songs"
  }

  // MARK: - Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Find a song").font(Tokens.editorial(68))
      Text(subtitle).font(Tokens.caption(22)).foregroundStyle(Tokens.text2)
    }
  }


  /// Say up front that playing needs a subscription, rather than letting someone
  /// search, pick, and only then meet the wall.
  private var subtitle: String {
    music.authStatus == .authorized
      ? "Apple Music · press Menu to go back"
      : "Browse freely — playing a result needs Apple Music"
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
        .focused($focus, equals: .field)
        .submitLabel(.search)
        .onSubmit { runSearch() }
        // Results arrive while the on-screen keyboard is still up, so by the
        // time it is dismissed the grid is already there. The debounce lives in
        // the service — the remote keyboard emits one character at a time.
        .onChange(of: query) { _, term in music.searchDebounced(term) }
        .frame(maxWidth: 820)

      Button {
        runSearch()
      } label: {
        Label("Search", systemImage: "magnifyingglass")
      }
      .buttonStyle(TVPillStyle())
      .disabled(query.trimmingCharacters(in: .whitespaces).count < 2)
    }
  }

  private func runSearch() {
    Task {
      await music.search(query)
      // Hand focus to the answer. Leaving it on the field means the viewer has
      // to swipe past the keyboard control to reach what they just asked for.
      if let first = music.searchResults.first { focus = .card(first.id) }
    }
  }

  // MARK: - Results

  @ViewBuilder
  private var results: some View {
    if let err = music.searchError, music.searchResults.isEmpty {
      statusBlock(
        icon: "exclamationmark.triangle.fill",
        title: "That search didn't go through",
        detail: err,
        tint: Tokens.ember
      )
    } else if music.isSearching && music.searchResults.isEmpty {
      // A skeleton grid rather than a spinner: it holds the shape the results
      // will take, so the screen does not reflow when they land.
      skeletonGrid
    } else if !music.searchResults.isEmpty {
      grid(music.searchResults)
    } else if let term = music.lastSearchTerm {
      statusBlock(
        icon: "questionmark.circle",
        title: "Nothing matched “\(term)”",
        detail: "Try the artist's name, or fewer words."
      )
    } else {
      startingPoint
    }
  }

  private func grid(_ songs: [CatalogItem]) -> some View {
    ScrollView(.vertical) {
      LazyVStack(alignment: .leading, spacing: 14) {
        ForEach(songs) { song in
          EditorialSongEntry(item: song, selected: focus == .card(song.id)) { start(song) }
            .focused($focus, equals: .card(song.id))
        }
      }.padding(.vertical, 20).padding(.horizontal, 6)
    }
  }

  private var skeletonGrid: some View {
    VStack(spacing: 20) {
      ForEach(0..<3, id: \.self) { _ in
        HStack(spacing: 28) {
          Rectangle().fill(Tokens.surface3).frame(width: 110, height: 110)
          VStack(alignment: .leading, spacing: 15) {
            Rectangle().fill(Tokens.surface3).frame(width: 600, height: 26)
            Rectangle().fill(Tokens.surface2).frame(width: 300, height: 18)
          }
          Spacer()
        }.padding(20).background(Tokens.surface1)
      }
    }
  }

  /// Nothing typed yet. Rather than an empty screen with a hint, show something
  /// pressable: what they played before, then what everyone is playing now.
  private var startingPoint: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        if !music.recentSongs.isEmpty {
          shelf("Recently played", music.recentSongs)
        }
        if !music.chartSongs.isEmpty {
          shelf("Top songs right now", music.chartSongs)
        }
      }
      .padding(.bottom, Tokens.Space.s3)
    }
  }

  private func shelf(_ title: String, _ items: [CatalogItem]) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(title).font(Tokens.editorial(38))
      ForEach(items.prefix(8)) { item in
        EditorialSongEntry(item: item, selected: focus == .card(item.id)) { start(item) }
          .focused($focus, equals: .card(item.id))
      }
    }
  }

  /// Only navigate when playback actually started — `play` returns false both
  /// when Apple Music is not connected (the root then shows the connect prompt)
  /// and when the song will not resolve. Pushing karaoke over silence was the
  /// original dead end here.
  private func start(_ item: CatalogItem) {
    Task {
      if await music.play(item) {
        path.append(Route.karaoke)
      }
    }
  }

  // MARK: - States

  private func statusBlock(
    icon: String?,
    title: String,
    detail: String?,
    tint: Color = Tokens.text2
  ) -> some View {
    HStack(alignment: .top, spacing: Tokens.Space.s3) {
      if let icon {
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
