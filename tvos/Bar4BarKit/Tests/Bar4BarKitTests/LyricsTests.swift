import XCTest
@testable import Bar4BarKit

final class LyricsTests: XCTestCase {
  func testTitleCleanup() {
    XCTAssertEqual(cleanTrackTitle("Song (feat. X) - Remastered 2011"), "Song")
    XCTAssertEqual(cleanTrackTitle("Anti-Hero"), "Anti-Hero")
    XCTAssertEqual(primaryArtist("A, B feat. C"), "A")
    XCTAssertEqual(primaryArtist("Drake ft. Rihanna"), "Drake")
  }

  func testTitleScore() {
    XCTAssertEqual(titleScore("Yellow", "yellow!"), 1)
    XCTAssertEqual(titleScore("Yellow", "Yellow Submarine"), 0.85)
    XCTAssertEqual(titleScore("", "x"), 0)
  }

  func testPickBestMatchPrefersTheRightLength() {
    let list: [[String: Any]] = [
      ["trackName": "Yellow", "artistName": "Coldplay", "duration": 400, "syncedLyrics": "live"],
      ["trackName": "Yellow", "artistName": "Coldplay", "duration": 266, "syncedLyrics": "album"],
      ["trackName": "Yellow", "artistName": "Someone Else", "duration": 267, "syncedLyrics": "cover"],
      ["trackName": "Yellow", "artistName": "Coldplay", "duration": 267, "syncedLyrics": ""],
    ]
    let hit = LyricsService.pickBestMatch(list, artist: "Coldplay", track: "Yellow", duration: 267)
    XCTAssertEqual(hit?["syncedLyrics"] as? String, "album")
    XCTAssertNil(LyricsService.pickBestMatch(list, artist: "Coldplay", track: "Clocks", duration: nil))
  }

  func testPreferSkipsTheWrongRecording() {
    let tl = Timeline(lines: [Line(start: 0, end: 1, words: [])])
    let wrongYrc = LyricsService.Candidate(LyricsResult(timeline: tl, source: "netease"), 380)
    let rightLrc = LyricsService.Candidate(LyricsResult(timeline: tl, source: "lrclib"), 241)
    XCTAssertEqual(LyricsService.prefer([wrongYrc, rightLrc], target: 240)?.source, "lrclib")
    XCTAssertEqual(LyricsService.prefer([wrongYrc, rightLrc], target: nil)?.source, "netease")
    XCTAssertNil(LyricsService.prefer([], target: 240))
  }
}
