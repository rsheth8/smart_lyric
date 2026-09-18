import XCTest
@testable import Bar4BarCore

final class NextPrepTests: XCTestCase {
  func testSameTrackPrefersRecordingIdentityOverTitle() {
    XCTAssertTrue(NextPrep.sameTrack(
      leftID: "follow:a",
      leftRecording: RecordingIdentity(spotifyID: "sp1"),
      leftArtist: "Adele",
      leftTitle: "Hello",
      rightID: "other",
      rightRecording: RecordingIdentity(spotifyID: "sp1"),
      rightArtist: "Adele",
      rightTitle: "Hello (Remastered)"
    ))
    XCTAssertFalse(NextPrep.sameTrack(
      leftID: "follow:a",
      leftRecording: RecordingIdentity(spotifyID: "sp1"),
      leftArtist: "Adele",
      leftTitle: "Hello",
      rightID: "follow:a",
      rightRecording: RecordingIdentity(spotifyID: "sp2"),
      rightArtist: "Adele",
      rightTitle: "Hello"
    ))
  }

  func testSameTrackUsesTitleWhenRecordingsDoNotConflict() {
    XCTAssertTrue(NextPrep.sameTrack(
      leftID: "follow:sp1",
      leftRecording: RecordingIdentity(spotifyID: "sp1"),
      leftArtist: "Ken Carson",
      leftTitle: "Strangers",
      rightID: "follow:other-key",
      rightRecording: RecordingIdentity(spotifyID: "sp1", isrc: "USUM70000000"),
      rightArtist: "Ken Carson",
      rightTitle: "Strangers"
    ))
  }

  func testSameTrackFallsBackToArtistAndTitle() {
    XCTAssertTrue(NextPrep.sameTrack(
      leftID: nil,
      leftRecording: nil,
      leftArtist: "Adele",
      leftTitle: "Hello",
      rightID: nil,
      rightRecording: nil,
      rightArtist: "Adele",
      rightTitle: "Hello"
    ))
  }

  func testQueueRefreshIsSparseUntilTheTrackIsAlmostOver() {
    XCTAssertTrue(NextPrep.shouldRefreshQueue(lastRefresh: nil, remaining: 120, now: 10))
    XCTAssertFalse(NextPrep.shouldRefreshQueue(lastRefresh: 10, remaining: 120, now: 14))
    XCTAssertTrue(NextPrep.shouldRefreshQueue(lastRefresh: 10, remaining: 120, now: 18))
    XCTAssertTrue(NextPrep.shouldRefreshQueue(lastRefresh: 10, remaining: 20, now: 13.1))
    XCTAssertFalse(NextPrep.shouldRefreshQueue(lastRefresh: 10, remaining: 20, now: 12))
  }

  func testParseQueueHeadReadsTheFirstUpcomingTrack() throws {
    let data = Data(#"""
    {"currently_playing":{"id":"now","name":"Now"},"queue":[
      {"id":"next1","name":"Next Song","duration_ms":181000,"explicit":true,
       "external_ids":{"isrc":"USRC17600000"},"artists":[{"name":"Artist"}],
       "album":{"name":"Album","images":[{"url":"https://i.scdn.co/a.jpg","width":640}]}},
      {"id":"next2","name":"Later"}
    ]}
    """#.utf8)
    let next = try XCTUnwrap(NextPrep.parseQueueHead(data))
    XCTAssertEqual(next.title, "Next Song")
    XCTAssertEqual(next.artist, "Artist")
    XCTAssertEqual(next.album, "Album")
    XCTAssertEqual(try XCTUnwrap(next.duration), 181, accuracy: 0.001)
    XCTAssertEqual(next.recording?.spotifyID, "next1")
    XCTAssertEqual(next.recording?.isrc, "USRC17600000")
    XCTAssertEqual(next.recording?.explicit, true)
    XCTAssertEqual(next.id, "")
  }

  func testParseQueueHeadIgnoresAnEmptyQueue() {
    XCTAssertNil(NextPrep.parseQueueHead(Data(#"{"queue":[]}"#.utf8)))
    XCTAssertNil(NextPrep.parseQueueHead(Data("{}".utf8)))
  }
}
