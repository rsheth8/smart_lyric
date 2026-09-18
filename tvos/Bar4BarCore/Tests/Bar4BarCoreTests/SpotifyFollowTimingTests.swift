import XCTest
@testable import Bar4BarCore

final class SpotifyFollowTimingTests: XCTestCase {
  func testPlayingProgressAdvancesByHalfTheRoundTrip() {
    XCTAssertEqual(
      SpotifyClient.compensatedProgress(progress: 10, isPlaying: true, rtt: 0.2),
      10.1,
      accuracy: 1e-9
    )
  }

  func testPausedProgressIsNotAdvanced() {
    XCTAssertEqual(
      SpotifyClient.compensatedProgress(progress: 10, isPlaying: false, rtt: 0.2),
      10,
      accuracy: 1e-9
    )
  }

  func testHungPollCannotJumpTheWipe() {
    XCTAssertEqual(
      SpotifyClient.compensatedProgress(progress: 10, isPlaying: true, rtt: 2),
      10.35,
      accuracy: 1e-9
    )
  }

  func testPollSpeedsUpNearTheEndOfATrack() {
    XCTAssertEqual(SpotifyClient.followPollInterval(remaining: 40, isPlaying: true), 1)
    XCTAssertEqual(SpotifyClient.followPollInterval(remaining: 20, isPlaying: true), 0.8)
    XCTAssertEqual(SpotifyClient.followPollInterval(remaining: 5, isPlaying: true), 0.4)
    XCTAssertEqual(SpotifyClient.followPollInterval(remaining: 5, isPlaying: false), 1)
    XCTAssertEqual(SpotifyClient.followPollInterval(remaining: nil, isPlaying: true), 1)
  }

  func testPlaybackStateCompensationIsAppliedWhilePlaying() throws {
    let data = Data(#"{"currently_playing_type":"track","item":{"id":"t1","name":"Song","duration_ms":180000,"artists":[{"name":"Artist"}],"album":{"name":"Album"}},"progress_ms":1000,"is_playing":true}"#.utf8)
    let playback = try XCTUnwrap(SpotifyClient.parsePlayback(data)?.compensating(rtt: 0.16))
    XCTAssertEqual(playback.progress, 1.08, accuracy: 1e-9)
  }

  func testPlayerCommandURLs() {
    XCTAssertEqual(SpotifyClient.PlayerCommand.pause.urlRequest.httpMethod, "PUT")
    XCTAssertEqual(SpotifyClient.PlayerCommand.pause.urlRequest.url?.path, "/v1/me/player/pause")
    XCTAssertEqual(SpotifyClient.PlayerCommand.play.urlRequest.httpMethod, "PUT")
    XCTAssertEqual(SpotifyClient.PlayerCommand.next.urlRequest.httpMethod, "POST")
    XCTAssertEqual(SpotifyClient.PlayerCommand.previous.urlRequest.httpMethod, "POST")
    let seek = SpotifyClient.PlayerCommand.seekMs(15_000).urlRequest
    XCTAssertEqual(seek.httpMethod, "PUT")
    XCTAssertEqual(seek.url?.path, "/v1/me/player/seek")
    XCTAssertEqual(seek.url?.query, "position_ms=15000")
  }
}
