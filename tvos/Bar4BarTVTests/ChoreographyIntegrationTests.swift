import XCTest
import Bar4BarCore
@testable import Bar4BarTV

@MainActor
final class ChoreographyIntegrationTests: XCTestCase {
  func testBundledDemoSidecarMatchesItsExactLyrics() throws {
    let bundle = Bundle(for: LyricsSession.self)
    let url = try XCTUnwrap(bundle.url(forResource: "bar4bar.choreography", withExtension: "json"))
    let choreography = try JSONDecoder().decode(Choreography.self, from: Data(contentsOf: url))
    let valid = try XCTUnwrap(choreography.validated(recording: DemoSong.stageRecording, timeline: DemoSong.timeline()))
    XCTAssertEqual(valid.sections.count, 7)
    XCTAssertEqual(valid.cues.count, 7)
    XCTAssertTrue(valid.sections.contains { $0.kind == .finale })
  }

  func testDemoSwitchKeepsTextAndRestoresReviewedChoreography() async {
    let session = LyricsSession()
    let music = MusicPlayerService()
    music.startDemo()
    await session.load(for: music.nowPlaying!)
    XCTAssertNotNil(session.choreography)
    let revision = session.lyricRevision
    session.setAutomaticDemo(true)
    XCTAssertNil(session.choreography)
    XCTAssertEqual(session.lyricRevision, revision)
    XCTAssertTrue(session.timeline.estimated)
    XCTAssertGreaterThan(session.timeline.lines[0].words.count, 1)
    session.setAutomaticDemo(false)
    XCTAssertNotNil(session.choreography)
    music.stopDemo()
  }
}
