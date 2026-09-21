import XCTest
@testable import Bar4BarKit

final class CompanionTests: XCTestCase {
  private func parse(_ json: String) -> PhoneCommand? {
    Companion.parseCommand(Data(json.utf8))
  }

  func testRoomCodesUseTheUnambiguousAlphabet() {
    for _ in 0..<50 {
      let code = Companion.newRoomCode()
      XCTAssertNotNil(code.range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression))
    }
    XCTAssertEqual(
      Companion.phoneURL(room: "LAVEGU23").absoluteString,
      "https://smartlyric.vercel.app/companion.html?room=LAVEGU23"
    )
  }

  func testPlayAndQueueAreSignedAndShaped() {
    let cmd = parse(#"{"type":"play","by":" Maya  ","song":{"track":" Yellow ","artist":"Coldplay","duration":266,"artwork":"http://x","evil":1}}"#)
    XCTAssertEqual(cmd, .play(Song(track: "Yellow", artist: "Coldplay", duration: 266, by: "Maya")))
    XCTAssertEqual(
      parse(#"{"type":"queue","song":{"track":"A","artwork":"https://art/1.jpg","duration":99999}}"#),
      .queue(Song(track: "A", artist: "", artwork: "https://art/1.jpg"))
    )
    XCTAssertNil(parse(#"{"type":"play","song":{"track":"  "}}"#))
  }

  func testRejectsMalformedCommands() {
    XCTAssertNil(parse("not json"))
    XCTAssertNil(parse(#"{"type":"rm -rf"}"#))
    XCTAssertNil(parse(#"{"type":"nudge","ms":500}"#))
    XCTAssertNil(parse(#"{"type":"nudge","ms":true}"#))
    XCTAssertNil(parse(#"{"type":"unqueue","index":1.5}"#))
    XCTAssertNil(parse(#"{"type":"unqueue","index":-1}"#))
    XCTAssertNil(parse(#"{"type":"feel","sense":"sideways"}"#))
  }

  func testSimpleCommands() {
    XCTAssertEqual(parse(#"{"type":"hello","by":"Sam"}"#), .hello(by: "Sam"))
    XCTAssertEqual(parse(#"{"type":"hello"}"#), .hello(by: nil))
    XCTAssertEqual(parse(#"{"type":"nudge","ms":-25}"#), .nudge(ms: -25))
    XCTAssertEqual(parse(#"{"type":"unqueue","index":2}"#), .unqueue(2))
    XCTAssertEqual(parse(#"{"type":"feel","sense":"late"}"#), .feel(early: false))
    XCTAssertEqual(parse(#"{"type":"toggle"}"#), .toggle)
  }

  func testNamesAreCapped() {
    XCTAssertEqual(Companion.parseName(String(repeating: "x", count: 40)).count, 24)
    XCTAssertEqual(Companion.parseName(42), "")
  }

  func testStateEncodesLikeTheWebTV() throws {
    let state = TVState(mode: "playing", track: "T", artist: "A", art: "", playing: true, offsetMs: -25,
                        queue: [Song(track: "Q", artist: "B", by: "Maya")])
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
    XCTAssertEqual(json["type"] as? String, "state")
    XCTAssertEqual(json["offsetMs"] as? Int, -25)
    let queued = (json["queue"] as! [[String: Any]])[0]
    XCTAssertEqual(queued["by"] as? String, "Maya")
    XCTAssertNil(queued["artwork"])
  }

  func testArtworkUpgrade() {
    XCTAssertEqual(
      Catalog.upgradeArtwork("https://is1.mzstatic.com/a/100x100bb.jpg"),
      "https://is1.mzstatic.com/a/600x600bb.jpg"
    )
    XCTAssertNil(Catalog.upgradeArtwork(""))
  }

  // MARK: - the rotation

  private func song(_ track: String, by: String?) -> Song {
    Song(track: track, artist: "A", by: by)
  }
  private func tracks(_ songs: [Song]) -> [String] { songs.map(\.track) }

  func testRotationInterleavesGuestsSoNobodyHogsTheRoom() {
    let queue = [
      song("a1", by: "Alex"), song("a2", by: "Alex"), song("a3", by: "Alex"),
      song("s1", by: "Sam"), song("m1", by: "Maya"),
    ]
    XCTAssertEqual(tracks(Companion.fairOrder(queue)), ["a1", "s1", "m1", "a2", "a3"])
  }

  func testRotationKeepsEachGuestsOwnOrder() {
    let queue = [song("a1", by: "Alex"), song("s1", by: "Sam"), song("a2", by: "Alex"), song("s2", by: "Sam")]
    XCTAssertEqual(tracks(Companion.fairOrder(queue)), ["a1", "s1", "a2", "s2"])
  }

  func testRotationIsANoOpForOnePhone() {
    let queue = [song("a1", by: "Alex"), song("a2", by: "Alex"), song("a3", by: "Alex")]
    XCTAssertEqual(tracks(Companion.fairOrder(queue)), ["a1", "a2", "a3"])
  }

  func testRotationIsANoOpForSongsAddedOnTheTV() {
    let queue = [song("t1", by: nil), song("t2", by: nil)]
    XCTAssertEqual(tracks(Companion.fairOrder(queue)), ["t1", "t2"])
  }

  func testRotationHandlesEmptyAndSingleQueues() {
    XCTAssertTrue(Companion.fairOrder([]).isEmpty)
    XCTAssertEqual(tracks(Companion.fairOrder([song("only", by: "Alex")])), ["only"])
  }

  func testRotationLosesNoSongsWhenLanesRunOutAtDifferentTimes() {
    let queue = [
      song("a1", by: "Alex"), song("a2", by: "Alex"), song("a3", by: "Alex"), song("a4", by: "Alex"),
      song("s1", by: "Sam"),
    ]
    let out = Companion.fairOrder(queue)
    XCTAssertEqual(out.count, queue.count, "a short lane must not drop the long lane's tail")
    XCTAssertEqual(Set(tracks(out)), Set(tracks(queue)))
    XCTAssertEqual(tracks(out), ["a1", "s1", "a2", "a3", "a4"])
  }
}
