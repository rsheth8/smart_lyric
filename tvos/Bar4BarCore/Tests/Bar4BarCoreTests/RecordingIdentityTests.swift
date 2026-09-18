import XCTest
@testable import Bar4BarCore

final class RecordingIdentityTests: XCTestCase {
  func testSpotifyIdentityKeepsPlaybackIDSeparateAndPreservesMilliseconds() throws {
    let data = Data(#"{"currently_playing_type":"track","item":{"id":"explicit-track","name":"Song","duration_ms":30123,"explicit":true,"external_ids":{"isrc":"usabc2600001"},"artists":[{"name":"Artist"}],"album":{"name":"Album"}},"progress_ms":1000,"is_playing":true}"#.utf8)
    let playback = try XCTUnwrap(SpotifyClient.parsePlayback(data))
    XCTAssertEqual(playback.item.id, "")
    XCTAssertEqual(playback.item.recording?.spotifyID, "explicit-track")
    XCTAssertEqual(playback.item.recording?.isrc, "USABC2600001")
    XCTAssertEqual(playback.item.recording?.explicit, true)
    XCTAssertEqual(playback.item.duration, 30.123)
  }

  func testSpotifyPodcastDoesNotEnterTheSongLyricsPipeline() {
    let data = Data(#"{"currently_playing_type":"episode","item":{"id":"episode-id","name":"A podcast episode","duration_ms":1800000},"progress_ms":1000,"is_playing":true}"#.utf8)
    XCTAssertNil(SpotifyClient.parsePlayback(data))
  }

  func testConflictingEditionsCannotMatchThroughAnISRC() {
    let target = RecordingIdentity(spotifyID: "a", isrc: "USABC2600001", explicit: true)
    XCTAssertTrue(target.matches(target))
    XCTAssertFalse(target.matches(.init(spotifyID: "b", isrc: "USABC2600001", explicit: true)))
    XCTAssertFalse(target.matches(.init(spotifyID: "a", explicit: false)))
    XCTAssertFalse(target.matches(.init(spotifyID: "a", isrc: "USABC2600002")))
    XCTAssertFalse(target.matches(nil))
    XCTAssertTrue(target.matches(.init(appleMusicID: "123", isrc: "USABC2600001", explicit: true)))
    XCTAssertFalse(target.matches(.init(isrc: "USABC2600001")))
  }

  func testCacheSeparatesIdenticalMetadataWithDifferentIDsAndEditions() {
    func key(_ id: String, explicit: Bool = true) -> String {
      TimelineCache.cacheKey(artist: "Artist", track: "Song", duration: 30,
        recording: .init(spotifyID: id, explicit: explicit))
    }
    XCTAssertNotEqual(key("a"), key("b"))
    XCTAssertNotEqual(key("a"), key("a", explicit: false))
    XCTAssertEqual(key("a"), key("a"))
    XCTAssertEqual(key("a").count, 64)
    XCTAssertNotEqual(TimelineCache.cacheKey(artist: "Artist", track: "Song", duration: 30.1),
                      TimelineCache.cacheKey(artist: "Artist", track: "Song", duration: 30.2))
    XCTAssertNotEqual(TimelineCache.cacheKey(artist: "Artist", track: "Song (Live)", duration: 30),
                      TimelineCache.cacheKey(artist: "Artist", track: "Song", duration: 30))
  }
}
