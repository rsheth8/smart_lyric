import Foundation
import Bar4BarCore

/// Original offline design-review entries, enabled only by a launch variable.
enum DemoBrowseFixture {
  static let items: [CatalogItem] = [
    item("words", "The room belongs to every voice that stayed until the last song", "Bar4Bar / Study One"),
    item("estimated", "Your voice, in good company", "Bar4Bar / Study Two"),
    item("mixed", "One word, then another", "Bar4Bar / Study Three"),
    item("unchecked", "An invitation to sing", "Bar4Bar / Study Four")
  ]
  private static func item(_ id: String, _ title: String, _ artist: String) -> CatalogItem {
    let identity = "bar4bar-browse-fixture-v1-\(id)"
    return CatalogItem(id: identity, title: title, artist: artist, album: "Original visual studies",
      duration: 52, recording: .init(appleMusicID: identity))
  }
  static func cache() -> TimelineCache {
    let store = TimelineCache(directory: FileManager.default.temporaryDirectory
      .appendingPathComponent("Bar4BarBrowseFixture-v1", isDirectory: true))
    let mixed = Timeline(lines: [LyricLine(start: 0, end: 2, words: [
      LyricWord(text: "One", start: 0, end: 1, timingQuality: .reliable),
      LyricWord(text: "voice", start: 1, end: 2, timingQuality: .estimated)
    ])], duration: 52, source: "richsync")
    for (index, timeline) in [DemoSong.timeline(), DemoSong.automaticTimeline(), mixed].enumerated() {
      let item = items[index]
      store.save(timeline, key: TimelineCache.cacheKey(artist: item.artist, track: item.title,
        duration: item.duration, album: item.album, recording: item.recording))
    }
    return store
  }
}
