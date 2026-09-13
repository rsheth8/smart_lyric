import Bar4BarKit
import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let singing = model.session != nil
    ZStack {
      TabView {
        HomeView().tabItem { Text("Home") }
        SearchView().tabItem { Text("Search") }
        RemoteView().tabItem { Text("Phone Remote") }
      }
      .disabled(singing)
      .scaleEffect(singing && !reduceMotion ? 0.94 : 1)
      .opacity(singing ? 0 : 1)

      if let session = model.session {
        SingView(session: session)
          .id(session.id)
          // Reduce Motion gets a plain crossfade instead of the zoom.
          .transition(reduceMotion ? AnyTransition.opacity : .asymmetric(
            insertion: .scale(scale: 1.06).combined(with: .opacity),
            removal: .scale(scale: 0.97).combined(with: .opacity)
          ))
          .zIndex(1)
      }
    }
    .animation(Motion.present, value: model.session?.id)
    .overlay(alignment: .top) { ToastView(text: model.toast) }
  }
}

/// The song lit up at the top of Home: whichever card has focus.
struct Spotlight: Equatable {
  var song: Song
  var eyebrow: String
}

struct HomeView: View {
  @Environment(AppModel.self) private var model
  @State private var spotlight: Spotlight?

  var body: some View {
    let shown = spotlight ?? model.chart.first.map { Spotlight(song: $0, eyebrow: "Number 1 right now") }
    VStack(alignment: .leading, spacing: 0) {
      SpotlightHeader(spotlight: shown)
        .frame(height: 290, alignment: .bottomLeading)
        .padding(.bottom, 36)
      ScrollViewReader { rows in
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            if !model.queue.isEmpty {
              Shelf(title: "Up next", songs: model.queue) { _, song in
                focus(song, song.by.map { "Queued by \($0)" } ?? "Up next", row: "Up next", rows)
              }
            }
            if !model.recent.isEmpty {
              Shelf(title: "Sing again", songs: model.recent) { _, song in
                focus(song, "You sang this recently", row: "Sing again", rows)
              }
            }
            if model.chart.isEmpty {
              SkeletonShelf()
            } else {
              Shelf(title: "Top songs", songs: model.chart, ranked: true) { i, song in
                focus(song, "Number \(i + 1) right now", row: "Top songs", rows)
              }
            }
          }
          .padding(.bottom, 80)
          .animation(Motion.glide, value: model.queue.map(\.id))
        }
        .mask {
          // Rows soften into the header above and the screen edge below.
          LinearGradient(
            stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.04), .init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
            startPoint: .top, endPoint: .bottom
          )
        }
      }
    }
    .background { Backdrop(url: shown?.song.artwork) }
  }

  /// Light up the focused song and glide its whole row, title included, to the top.
  private func focus(_ song: Song, _ eyebrow: String, row: String, _ rows: ScrollViewProxy) {
    spotlight = Spotlight(song: song, eyebrow: eyebrow)
    withAnimation(Motion.glide) { rows.scrollTo(row, anchor: .top) }
  }
}

struct SpotlightHeader: View {
  let spotlight: Spotlight?

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      if let spotlight {
        VStack(alignment: .leading, spacing: 12) {
          Text(spotlight.eyebrow.uppercased())
            .font(.caption.weight(.semibold)).tracking(4)
            .foregroundStyle(Theme.accent)
          Text(spotlight.song.track)
            .font(.system(size: 80, weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          HStack(spacing: 28) {
            Text(spotlight.song.artist).foregroundStyle(.secondary)
            Label("Press to sing", systemImage: "music.mic").foregroundStyle(.tertiary)
          }
          .font(.title3)
        }
        .frame(maxWidth: 1400, alignment: .leading)
        .id(spotlight.song.id)
        // The old title gets out of the way before the new one rises in, so they never overlap.
        .transition(.asymmetric(
          insertion: .opacity.combined(with: .offset(y: 18)).animation(Motion.glide.delay(0.12)),
          removal: .opacity.animation(.easeOut(duration: 0.14))
        ))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
  }
}

struct Shelf: View {
  let title: String
  let songs: [Song]
  var ranked = false
  let onFocus: (Int, Song) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).font(.title3.weight(.semibold)).foregroundStyle(.secondary)
      ScrollView(.horizontal) {
        LazyHStack(alignment: .bottom, spacing: 56) {
          ForEach(Array(songs.enumerated()), id: \.element.id) { i, song in
            SongCard(song: song, rank: ranked ? i + 1 : nil) { onFocus(i, song) }
              .transition(.opacity.combined(with: .scale(scale: 0.9)))
          }
        }
        .padding(.vertical, 36)
      }
      .scrollClipDisabled()
    }
    .padding(.top, 8)
    .id(title)
    .focusSection()
  }
}

struct SongCard: View {
  let song: Song
  var rank: Int?
  var size: CGFloat = 260
  var onFocus: () -> Void = {}
  @Environment(AppModel.self) private var model
  @FocusState private var focused: Bool
  /// This card opened the stage.
  @State private var picked = false

  var body: some View {
    HStack(alignment: .bottom, spacing: -26) {
      if let rank {
        Text("\(rank)")
          .font(.system(size: 190, weight: .black, design: .rounded))
          .foregroundStyle(LinearGradient(colors: [.white.opacity(focused ? 0.5 : 0.28), .white.opacity(0.02)], startPoint: .top, endPoint: .bottom))
          .offset(y: 52)
          .accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 18) {
        Button {
          picked = true
          model.sing(song)
        } label: {
          Artwork(url: song.artwork).frame(width: size, height: size)
        }
        .buttonStyle(.card)
        .focused($focused)
        .accessibilityLabel("\(song.track), \(song.artist)")
        VStack(alignment: .leading, spacing: 4) {
          Text(song.track).font(.callout.weight(.semibold)).foregroundStyle(focused ? .primary : .secondary)
          Text(song.by.map { "\(song.artist) · \($0)" } ?? song.artist).font(.caption).foregroundStyle(.tertiary)
        }
        .lineLimit(1)
        .frame(width: size, alignment: .leading)
        .offset(y: focused ? 18 : 0)
        .accessibilityHidden(true)
      }
    }
    .animation(Motion.snappy, value: focused)
    .onChange(of: focused) { _, isFocused in
      if isFocused { onFocus() }
    }
    // The stage is an overlay, not a presentation, so nothing restores focus when it
    // closes: the card the song was picked from takes it back.
    .onChange(of: model.session == nil) { _, closed in
      if closed && picked {
        picked = false
        focused = true
      }
    }
  }
}

/// Where the chart will be, breathing while it loads.
struct SkeletonShelf: View {
  @State private var lit = false

  var body: some View {
    HStack(spacing: 56) {
      ForEach(0..<6, id: \.self) { _ in
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.white.opacity(lit ? 0.1 : 0.04))
          .frame(width: 260, height: 260)
      }
    }
    .padding(.vertical, 36)
    .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { lit = true } }
  }
}

struct SearchView: View {
  @Environment(AppModel.self) private var model
  @State private var query = ""
  @State private var results: [Song] = []
  @State private var searching = false

  var body: some View {
    let browsing = query.trimmingCharacters(in: .whitespaces).count < 2
    let songs = browsing ? model.chart : results
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text(browsing ? "Popular right now" : searching ? "Searching…" : results.isEmpty ? "No songs match “\(query)”" : "Songs")
            .font(.title3.weight(.semibold))
            .foregroundStyle(.secondary)
            .contentTransition(.opacity)
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 260), spacing: 56)], spacing: 64) {
            ForEach(songs) { song in
              SongCard(song: song).transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
          }
          .padding(.vertical, 40)
        }
        .animation(Motion.glide, value: songs.map(\.id))
        .animation(Motion.snappy, value: searching)
      }
      .searchable(text: $query, prompt: "Songs or artists")
      .task(id: query) {
        guard !browsing else { return }
        try? await Task.sleep(for: .milliseconds(350)) // debounce typing
        guard !Task.isCancelled else { return }
        searching = true
        let found = await Catalog.search(query)
        guard !Task.isCancelled else { return }
        results = found
        searching = false
      }
    }
  }
}
