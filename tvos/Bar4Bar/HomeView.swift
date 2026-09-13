import Bar4BarKit
import SwiftUI

enum Theme {
  static let accent = Color(red: 0.89, green: 0.76, blue: 0.48)
  static let sung = Color(red: 0.965, green: 0.94, blue: 0.894)
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    TabView {
      HomeView().tabItem { Text("Home") }
      SearchView().tabItem { Text("Search") }
      RemoteView().tabItem { Text("Phone Remote") }
    }
    .overlay(alignment: .top) { ToastView(text: model.session == nil ? model.toast : nil) }
    .fullScreenCover(item: $model.session) { session in
      SingView(session: session).environment(model)
    }
  }
}

struct HomeView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let hero = model.recent.first ?? model.chart.first
    ScrollView {
      VStack(alignment: .leading, spacing: 64) {
        if let hero {
          Hero(song: hero, eyebrow: model.recent.isEmpty ? "Number one right now" : "Pick up where you left off")
        }
        if !model.queue.isEmpty { Shelf(title: "Up next", songs: model.queue) }
        if model.recent.count > 1 { Shelf(title: "Sing again", songs: Array(model.recent.dropFirst())) }
        if model.chart.isEmpty {
          ProgressView().frame(maxWidth: .infinity)
        } else {
          Shelf(title: "Top songs", songs: model.chart)
        }
      }
      .padding(.bottom, 80)
    }
    .background { Backdrop(url: hero?.artwork) }
  }
}

struct Hero: View {
  let song: Song
  let eyebrow: String
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 64) {
      Artwork(url: song.artwork)
        .frame(width: 440, height: 440)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.5), radius: 40, y: 24)
      VStack(alignment: .leading, spacing: 16) {
        Text(eyebrow.uppercased())
          .font(.caption.weight(.semibold)).tracking(3)
          .foregroundStyle(Theme.accent)
        Text(song.track)
          .font(.system(size: 84, weight: .bold))
          .lineLimit(2)
        Text(song.artist)
          .font(.title2)
          .foregroundStyle(.secondary)
        Button { model.sing(song) } label: {
          Label("Sing", systemImage: "music.mic").padding(.horizontal, 28)
        }
        .padding(.top, 28)
      }
      Spacer(minLength: 0)
    }
    .padding(.top, 30)
    .focusSection()
  }
}

struct Shelf: View {
  let title: String
  let songs: [Song]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.title3.weight(.semibold)).foregroundStyle(.secondary)
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 48) {
          ForEach(songs) { SongCard(song: $0) }
        }
        .padding(.vertical, 32)
      }
      .scrollClipDisabled()
    }
    .focusSection()
  }
}

struct SongCard: View {
  let song: Song
  var size: CGFloat = 280
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Button { model.sing(song) } label: {
        Artwork(url: song.artwork).frame(width: size, height: size)
      }
      .buttonStyle(.card)
      VStack(alignment: .leading, spacing: 4) {
        Text(song.track).font(.callout.weight(.semibold))
        Text(song.by.map { "\(song.artist) · \($0)" } ?? song.artist)
          .font(.caption).foregroundStyle(.secondary)
      }
      .lineLimit(1)
      .frame(width: size, alignment: .leading)
    }
  }
}

struct SearchView: View {
  @State private var query = ""
  @State private var results: [Song] = []

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280, maximum: 280), spacing: 48)], spacing: 56) {
          ForEach(results) { SongCard(song: $0) }
        }
        .padding(.vertical, 40)
      }
      .searchable(text: $query, prompt: "Songs or artists")
      .task(id: query) {
        try? await Task.sleep(for: .milliseconds(350)) // debounce typing
        guard !Task.isCancelled else { return }
        results = await Catalog.search(query)
      }
    }
  }
}

struct Artwork: View {
  let url: String?

  var body: some View {
    Color(white: 0.14)
      .overlay {
        AsyncImage(url: url.flatMap(URL.init(string:))) { phase in
          if let image = phase.image {
            image.resizable().scaledToFill()
          } else {
            Image(systemName: "music.note").font(.system(size: 64)).foregroundStyle(.tertiary)
          }
        }
      }
      .clipped()
  }
}

/// The song's own artwork, blown up and blurred into light behind everything.
struct Backdrop: View {
  let url: String?

  var body: some View {
    Color.black
      .overlay {
        AsyncImage(url: url.flatMap(URL.init(string:))) { image in
          image.resizable().scaledToFill().blur(radius: 90).saturation(1.4).opacity(0.55)
        } placeholder: {
          Color.clear
        }
      }
      .overlay(LinearGradient(colors: [.black.opacity(0.1), .black.opacity(0.85)], startPoint: .top, endPoint: .bottom))
      .clipped()
      .ignoresSafeArea()
  }
}

struct ToastView: View {
  let text: String?

  var body: some View {
    if let text {
      Text(text)
        .font(.headline)
        .padding(.horizontal, 36)
        .padding(.vertical, 18)
        .background(.regularMaterial, in: Capsule())
        .padding(.top, 40)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
  }
}
