import SwiftUI
import Bar4BarCore

/// A horizontal editorial entry with recording-specific saved timing availability.
struct EditorialSongEntry: View {
  @EnvironmentObject private var session: LyricsSession
  @State private var guidance = SongGuidance.unchecked
  var item: CatalogItem
  var selected = false
  var compact = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 26) {
        CoverArt(url: item.artworkURL, side: compact ? 115 : 120, corner: 4)
        VStack(alignment: .leading, spacing: 8) {
          Text(item.title).font(Tokens.editorial(compact ? 32 : selected ? 42 : 34))
            .lineLimit(2).minimumScaleFactor(0.8)
          Text(item.artist).font(Tokens.control(23)).lineLimit(1)
          Text(guidance.label).font(Tokens.caption(17)).opacity(0.75)
        }.frame(maxWidth: .infinity, alignment: .leading)
        if !compact {
          VStack(alignment: .trailing, spacing: 10) {
            Image(systemName: "arrow.up.right").font(.system(size: 28))
            if let duration = item.duration {
              Text("\(Int(duration) / 60):\(String(format: "%02d", Int(duration) % 60))")
                .font(Tokens.caption(19)).monospacedDigit()
            }
          }
        }
      }.frame(width: compact ? 575 : nil, height: compact ? 150 : 184, alignment: .leading)
    }.buttonStyle(EditorialEntryStyle()).accessibilityIdentifier("song-\(item.id)")
      .task(id: TimelineCache.cacheKey(artist: item.artist, track: item.title,
        duration: item.duration, album: item.album, recording: item.recording)) {
        let saved = await session.savedGuidance(for: item)
        guard !Task.isCancelled else { return }
        guidance = saved
      }
  }
}

private struct EditorialEntryStyle: ButtonStyle {
  @Environment(\.isFocused) private var focused
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.padding(.horizontal, 24).padding(.vertical, 12)
      .foregroundStyle(focused ? Tokens.surfaceSolid1 : Tokens.text1)
      .background(focused ? Tokens.text1 : Tokens.surfaceSolid1.opacity(0.88))
      .overlay(alignment: .leading) { Rectangle().fill(Tokens.ember).frame(width: focused ? 7 : 2) }
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
