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
        CoverArt(url: item.artworkURL, side: compact ? 108 : 104, corner: 5)
        VStack(alignment: .leading, spacing: 8) {
          Text(item.title).font(Tokens.editorial(compact ? 31 : selected ? 38 : 34))
            .lineLimit(2).minimumScaleFactor(0.8)
          Text(item.artist).font(Tokens.control(23)).lineLimit(1)
          Text(guidance.label).font(Tokens.caption(18)).foregroundStyle(Tokens.text2)
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
      }.frame(width: compact ? 575 : nil, height: compact ? 136 : 146, alignment: .leading)
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
    configuration.label.padding(.horizontal, 22).padding(.vertical, 10)
      .foregroundStyle(Tokens.text1)
      .background(focused ? Tokens.surfaceSolid2 : Tokens.surfaceSolid1.opacity(0.90),
                  in: RoundedRectangle(cornerRadius: 12))
      .overlay(alignment: .leading) {
        RoundedRectangle(cornerRadius: 3).fill(Tokens.ember)
          .frame(width: focused ? 5 : 2).padding(.vertical, 12)
      }
      .overlay(RoundedRectangle(cornerRadius: 12)
        .stroke(focused ? Tokens.ink.opacity(0.80) : Tokens.line1, lineWidth: focused ? 2 : 1))
      .scaleEffect(focused ? 1.008 : 1)
      .animation(.easeOut(duration: 0.22), value: focused)
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
