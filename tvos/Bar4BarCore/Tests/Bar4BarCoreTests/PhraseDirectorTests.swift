import XCTest
@testable import Bar4BarCore

final class PhraseDirectorTests: XCTestCase {
  private let identity = RecordingIdentity(appleMusicID: "fixture")
  private func timeline(estimated: Bool = false) -> Timeline {
    Timeline(lines: [
      LyricLine(start: 1, end: 4, words: [LyricWord(text: "Come", start: 1, end: 2), LyricWord(text: "alive", start: 2, end: 4)]),
      LyricLine(start: 5, end: 7, words: [LyricWord(text: "Together", start: 5, end: 7)])
    ], duration: 8, estimated: estimated, source: estimated ? "lrc" : "demo")
  }
  private func sidecar(_ timeline: Timeline) -> Choreography {
    Choreography(version: 1, recording: identity, lyricRevision: timeline.lyricRevision,
      sections: [.init(start: 1, end: 4, kind: .build, provenance: .reviewed)],
      cues: [.init(line: 0, word: 1, effect: .emphasis, provenance: .reviewed)])
  }
  private func sample(_ time: Double, cue: Double? = nil, playing: Bool = true, revision: Int = 0, seek: Int = 0) -> StageSample {
    StageSample(playback: time, audible: time, cue: cue ?? time + 0.12, playing: playing, timingRevision: revision, seekRevision: seek)
  }

  func testSectionUnfoldingFreezesOnPauseSurvivesRevisionAndResolvesSeek() {
    let tl = timeline()
    let sections = [Sections.Section(part: .chorus, start: 5, end: 8)]
    var director = PhraseDirector()
    _ = director.advance(timeline: tl, sections: sections, choreography: nil, sample: sample(4.4))
    let arrival = director.advance(timeline: tl, sections: sections, choreography: nil, sample: sample(5.05))
    XCTAssertEqual(arrival.kind, .chorus)
    XCTAssertEqual(arrival.previousKind, .verse)
    XCTAssertEqual(arrival.sectionTransition, 0)
    let progress = director.advance(timeline: tl, sections: sections, choreography: nil, sample: sample(5.25))
    XCTAssertGreaterThan(progress.sectionTransition, 0)
    let paused = director.advance(timeline: tl, sections: sections, choreography: nil, sample: sample(5.25, playing: false, revision: 8))
    XCTAssertEqual(paused.sectionTransition, progress.sectionTransition)
    let sought = director.advance(timeline: tl, sections: sections, choreography: nil, sample: sample(3, seek: 1))
    XCTAssertEqual(sought.kind, .verse)
    XCTAssertEqual(sought.previousKind, .verse)
    XCTAssertEqual(sought.sectionTransition, 1)
    XCTAssertEqual(sought.arrival, 0)
  }

  func testSidecarRejectsWrongRecordingRevisionAndVersion() {
    let tl = timeline()
    var cues = sidecar(tl)
    XCTAssertNotNil(cues.validated(recording: identity, timeline: tl))
    XCTAssertNil(cues.validated(recording: .init(appleMusicID: "another"), timeline: tl))
    cues.lyricRevision = "changed"
    XCTAssertNil(cues.validated(recording: identity, timeline: tl))
    cues = sidecar(tl); cues.version = 2
    XCTAssertNil(cues.validated(recording: identity, timeline: tl))
  }
  func testInvalidReferencesAreDroppedIndividually() {
    let tl = timeline()
    var cues = sidecar(tl)
    cues.cues.append(.init(line: 100, word: 0, effect: .hold, provenance: .reviewed))
    cues.cues.append(.init(line: 0, word: -1, effect: .hold, provenance: .reviewed))
    cues.sections.append(.init(start: -1, end: 2, kind: .chorus, provenance: .reviewed))
    XCTAssertEqual(cues.validated(recording: identity, timeline: tl)?.cues.count, 1)
    XCTAssertEqual(cues.validated(recording: identity, timeline: tl)?.sections.count, 1)
  }
  func testMixedLRCKeepsKnownWordQualityAndEstimatesRemainingWords() {
    let tl = LRC.parse("[00:01.00]<00:01.00>Hello <00:02.00>world\n[00:05.00]Come alive")
    XCTAssertFalse(tl.hasWordTiming)
    XCTAssertEqual(tl.quality(line: 0, word: 1), .reliable)
    XCTAssertEqual(tl.quality(line: 1, word: 0), .estimated)
    XCTAssertEqual(tl.lines[1].words.count, 2)
    XCTAssertLessThan(tl.lines[1].words[0].start, tl.lines[1].words[1].start)
  }
  func testOldCachesDecodeAndTimingQualitySurvivesRoundTrip() throws {
    let old = Data(#"{"text":"hello","start":0,"end":1}"#.utf8)
    XCTAssertNil(try JSONDecoder().decode(LyricWord.self, from: old).timingQuality)
    let tl = LRC.parse("[00:01.00]Come alive")
    let decoded = try JSONDecoder().decode(Timeline.self, from: JSONEncoder().encode(tl))
    XCTAssertEqual(decoded.quality(line: 0, word: 1), .estimated)
  }
  func testEstimatedLongTailNeverTriggersHold() {
    var director = PhraseDirector()
    let tl = timeline(estimated: true)
    XCTAssertNil(director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(2.4)).hold)
    let known = timeline()
    XCTAssertEqual(director.advance(timeline: known, sections: [], choreography: nil, sample: sample(2.5)).hold, 1)
  }
  func testReviewedSectionOverridesAutomaticAndUsesAudibleTime() {
    var director = PhraseDirector()
    let tl = timeline()
    let sections = [Sections.Section(part: .chorus, start: 0, end: 8)]
    let out = director.advance(timeline: tl, sections: sections, choreography: sidecar(tl), sample: sample(3.9, cue: 5.1))
    XCTAssertEqual(out.kind, .build)
    XCTAssertGreaterThan(out.build, 0.9)
  }
  func testRevisionCannotReplayEmphasisOrRegressPhrase() {
    var director = PhraseDirector()
    var tl = timeline()
    let cues = sidecar(tl)
    _ = director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(1.9))
    XCTAssertEqual(director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(2.05)).emphasis, 1)
    _ = director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(2.6))
    tl.lines[0].words[1].start = 2.65
    XCTAssertNil(director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(2.7, revision: 1)).emphasis)
    _ = director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(4.2, seek: 1))
    XCTAssertEqual(director.advance(timeline: tl, sections: [], choreography: cues, sample: sample(4.3, cue: 3.8, revision: 2, seek: 1)).line, 1)
  }
  func testPauseFreezesMotionAndSeekShowsWordsImmediately() {
    var director = PhraseDirector()
    let tl = timeline()
    _ = director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(0.5))
    let running = director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(0.7))
    let paused = director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(0.7, playing: false))
    XCTAssertEqual(paused.motionTime, running.motionTime)
    let sought = director.advance(timeline: tl, sections: [], choreography: sidecar(tl), sample: sample(2.1, seek: 1))
    XCTAssertEqual(sought.entrance, 1)
    XCTAssertNil(sought.emphasis)
  }
  func testFingerprintIgnoresTimingAndTranslationButTracksWords() {
    let tl = timeline()
    var changed = tl
    changed.lines[0].words[0].start += 0.1
    changed.lines[0].roman = "pronunciation"
    XCTAssertEqual(tl.lyricRevision, changed.lyricRevision)
    changed.lines[0].words[0].text = "different"
    XCTAssertNotEqual(tl.lyricRevision, changed.lyricRevision)
  }
  func testLongGapPreviewAndEnding() {
    var director = PhraseDirector()
    let tl = timeline()
    let gap = director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(4.2))
    XCTAssertEqual(gap.line, 1)
    XCTAssertNotNil(gap.countdown)
    let end = director.advance(timeline: tl, sections: [], choreography: nil, sample: sample(7.2))
    XCTAssertTrue(end.ending)
    XCTAssertNil(end.next)
  }
}
