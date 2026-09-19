import SwiftUI
import MusicKit
import Bar4BarCore

/// Catalog search — songs or albums.
///
/// Four states per scope: never searched, searching, found nothing, failed.
/// Album tap drills into a song search for that release rather than adding a
/// new screen — the album is a filter, not a destination.
struct SearchView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath
  @State private var query = ""
  @State private var scope: MusicPlayerService.SearchScope = .songs

  private enum SearchFocus: Hashable {
    case field
    case scopeSongs
    case scopeAlbums
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
      .animation(Tokens.Motion.page, value: music.albumResults.count)
      .animation(Tokens.Motion.page, value: music.isSearching)
    }
    .onChange(of: scope) { _, newScope in
      music.searchResults = []
      music.albumResults = []
      if query.count >= 2 { music.searchDebounced(query, scope: newScope) }
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
      focus = activeResults.first.map { .card($0.id) } ?? .field
    }
  }

  private var activeResults: [CatalogItem] {
    scope == .albums ? music.albumResults : music.searchResults
  }

  private var focusedTitle: String {
    guard case let .card(id) = focus else { return "Find songs" }
    let all = music.searchResults + music.albumResults + music.recentSongs + music.chartSongs
    return all.first(where: { $0.id == id })?.title ?? "Find songs"
  }

  // MARK: - Header

  private var header: some View {
    HStack(alignment: .bottom, spacing: Tokens.Space.s5) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Search").font(Tokens.editorial(68))
        Text(subtitle).font(Tokens.caption(22)).foregroundStyle(Tokens.text2)
      }
      Spacer()
      scopePicker
    }
  }

  private var subtitle: String {
    music.authStatus == .authorized
      ? "Apple Music · press Menu to go back"
      : "Browse freely — playing needs Apple Music"
  }

  // MARK: - Scope picker

  private var scopePicker: some View {
    HStack(spacing: 4) {
      scopeButton("Songs", value: .songs)
      scopeButton("Albums", value: .albums)
    }
    .padding(4)
    .background(Tokens.surface1, in: Capsule())
    .overlay(Capsule().stroke(Tokens.line1, lineWidth: 1))
  }

  private func scopeButton(_ label: String, value: MusicPlayerService.SearchScope) -> some View {
    Button(label) {
      guard scope != value else { return }
      scope = value
    }
    .focused($focus, equals: value == .songs ? .scopeSongs : .scopeAlbums)
    .buttonStyle(ScopeTabStyle(selected: scope == value))
  }

  // MARK: - Search bar

  private var searchBar: some View {
    HStack(spacing: Tokens.Space.s3) {
      TextField(scope == .albums ? "Album or artist" : "Song or artist", text: $query)
        .textFieldStyle(.plain)
        .font(Tokens.display(Tokens.FontSize.md, .medium))
        .focused($focus, equals: .field)
        .submitLabel(.search)
        .onSubmit { runSearch() }
        .onChange(of: query) { _, term in music.searchDebounced(term, scope: scope) }
        .frame(maxWidth: 820)

      Button { runSearch() } label: {
        Label("Search", systemImage: "magnifyingglass")
      }
      .buttonStyle(TVPillStyle())
      .disabled(query.trimmingCharacters(in: .whitespaces).count < 2)
    }
  }

  private func runSearch() {
    Task {
      if scope == .albums {
        await music.searchAlbums(query)
      } else {
        await music.search(query)
      }
      if let first = activeResults.first { focus = .card(first.id) }
    }
  }

  // MARK: - Results

  @ViewBuilder
  private var results: some View {
    if let err = music.searchError, activeResults.isEmpty {
      statusBlock(
        icon: "exclamationmark.triangle.fill",
        title: "That search didn't go through",
        detail: err,
        tint: Tokens.ember
      )
    } else if music.isSearching && activeResults.isEmpty {
      skeletonGrid
    } else if !activeResults.isEmpty {
      grid(activeResults)
    } else if let term = music.lastSearchTerm {
      statusBlock(
        icon: "questionmark.circle",
        title: "Nothing matched \u{201C}\(term)\u{201D}",
        detail: scope == .albums
          ? "Try an artist name or shorter album title."
          : "Try the artist's name, or fewer words."
      )
    } else {
      startingPoint
    }
  }

  private func grid(_ items: [CatalogItem]) -> some View {
    ScrollView(.vertical) {
      LazyVStack(alignment: .leading, spacing: 14) {
        ForEach(items) { item in
          EditorialSongEntry(item: item, selected: focus == .card(item.id)) { tap(item) }
            .focused($focus, equals: .card(item.id))
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
        EditorialSongEntry(item: item, selected: focus == .card(item.id)) { tap(item) }
          .focused($focus, equals: .card(item.id))
      }
    }
  }

  private func tap(_ item: CatalogItem) {
    if scope == .albums {
      scope = .songs
      query = item.title
      music.albumResults = []
      Task {
        await music.search("\(item.title) \(item.artist)")
        if let first = music.searchResults.first { focus = .card(first.id) }
      }
    } else {
      start(item)
    }
  }

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

// MARK: - Scope tab style

private struct ScopeTabStyle: ButtonStyle {
  var selected: Bool
  @Environment(\.isFocused) private var focused

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Tokens.display(Tokens.FontSize.base, .semibold))
      .foregroundStyle(focused ? Tokens.accentInk : selected ? Tokens.text1 : Tokens.text3)
      .padding(.horizontal, Tokens.Space.s4)
      .padding(.vertical, Tokens.Space.s2)
      .background(
        focused ? Tokens.accentStatic : selected ? Tokens.surface3 : Color.clear,
        in: Capsule()
      )
      .animation(Tokens.Motion.easeOut, value: focused)
  }
}
