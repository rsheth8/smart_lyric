import XCTest
import Bar4BarCore
@testable import Bar4BarTV

@MainActor
final class SongGuidanceTests: XCTestCase {
  func testMixedEvidenceKeepsAvailableWordGuidance() {
    let timeline = Timeline(lines: [LyricLine(start: 0, end: 2, words: [
      LyricWord(text: "Sing", start: 0, end: 1, timingQuality: .reliable),
      LyricWord(text: "together", start: 1, end: 2, timingQuality: .estimated)
    ])], duration: 2, source: "richsync")
    XCTAssertEqual(SongGuidance(timeline: timeline), .mixed)
    XCTAssertEqual(SongGuidance(timeline: DemoSong.automaticTimeline()), .estimated)
    XCTAssertEqual(SongGuidance(timeline: DemoSong.timeline()), .words)
    XCTAssertEqual(SongGuidance(timeline: nil), .unchecked)
    XCTAssertEqual(SongGuidance(timeline: Timeline(lines: [])), .unchecked)
  }

  func testSavedAvailabilityCannotLeakAcrossRecordingEditions() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = TimelineCache(directory: directory)
    let item = CatalogItem(id: "edition-a", title: "Original title", artist: "Original artist",
      album: "Original album", duration: 52, recording: .init(appleMusicID: "edition-a"))
    let key = TimelineCache.cacheKey(artist: item.artist, track: item.title,
      duration: item.duration, album: item.album, recording: item.recording)
    cache.save(DemoSong.automaticTimeline(), key: key)
    let session = LyricsSession(cache: cache)
    let available = await session.savedGuidance(for: item)
    XCTAssertEqual(available, .estimated)
    let another = CatalogItem(id: "edition-b", title: item.title, artist: item.artist,
      album: item.album, duration: item.duration, recording: .init(appleMusicID: "edition-b"))
    let otherGuidance = await session.savedGuidance(for: another)
    XCTAssertEqual(otherGuidance, .unchecked)
  }

  func testIncomingTurnUsesUpcomingPhraseAndExplicitParticipation() {
    let timeline = DemoSong.timeline()
    var state = StagePresentation()
    state.line = 4; state.next = 5
    let turn = SingerTurnPreview(timeline: timeline, state: state, cueTime: 26,
      preview: 1.5, mode: "Take turns")
    XCTAssertEqual(turn?.role, "SIDE B")
    XCTAssertEqual(turn?.seconds, 2)
    XCTAssertNil(SingerTurnPreview(timeline: timeline, state: state, cueTime: 26, preview: 1.5, mode: "Solo"))
    XCTAssertNil(SingerTurnPreview(timeline: timeline, state: state, cueTime: 26, preview: 1.5, mode: "Everyone"))
    XCTAssertNil(SingerTurnPreview(timeline: timeline, state: state, cueTime: 20, preview: 1.5, mode: "Take turns"))
    state.line = 5; state.countdown = 1.8
    XCTAssertEqual(SingerTurnPreview(timeline: timeline, state: state, cueTime: 26,
      preview: 1.5, mode: "Take turns")?.role, "SIDE B")
    state.ending = true
    XCTAssertNil(SingerTurnPreview(timeline: timeline, state: state, cueTime: 26, preview: 1.5, mode: "Take turns"))
  }
}
