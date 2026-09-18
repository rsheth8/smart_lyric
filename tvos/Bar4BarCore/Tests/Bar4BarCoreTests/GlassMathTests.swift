import XCTest
@testable import Bar4BarCore

final class GlassMathTests: XCTestCase {

  // Neutral state: verse, no hold, no cheer, no breath, playing
  private func neutral(kind: Choreography.Kind = .verse, previousKind: Choreography.Kind = .verse) -> StagePresentation {
    var s = StagePresentation()
    s.kind = kind
    s.previousKind = previousKind
    s.sectionTransition = 1.0
    s.hold = nil
    s.impact = 0
    return s
  }

  private func field(
    state: StagePresentation,
    intensity: StageIntensity,
    partyMode: String = "Solo",
    sideA: Bool = true,
    cheer: Double = 0,
    playing: Bool = true,
    wordKick: Double = 0
  ) -> GlassField {
    GlassMath.field(
      state: state,
      intensity: intensity,
      partyMode: partyMode,
      sideA: sideA,
      cheer: cheer,
      playing: playing,
      reduceMotion: false,
      nextVocalIn: nil,
      inLongGap: false,
      wordKick: wordKick,
      previewSeconds: 1.5
    )
  }

  // 1. iris focus < live < headliner at identical neutral state
  func testIrisOrderAcrossIntensities() {
    let st = neutral()
    let f = field(state: st, intensity: .focus).iris
    let l = field(state: st, intensity: .live).iris
    let h = field(state: st, intensity: .headliner).iris
    XCTAssertLessThan(f, l)
    XCTAssertLessThan(l, h)
  }

  // 2. Chorus raises iris vs verse at same intensity
  func testChorusRaisesIris() {
    let verse = field(state: neutral(kind: .verse), intensity: .live).iris
    let chorus = field(state: neutral(kind: .chorus), intensity: .live).iris
    XCTAssertGreaterThan(chorus, verse)
  }

  // 3. hold drops iris by >= 50% (chorus + headliner to get high base)
  func testHoldDropsIris() {
    var withHold = neutral(kind: .chorus)
    withHold.hold = 0
    var withoutHold = neutral(kind: .chorus)
    withoutHold.hold = nil

    let irisHeld = field(state: withHold,    intensity: .headliner).iris
    let irisOpen = field(state: withoutHold, intensity: .headliner).iris
    XCTAssertLessThanOrEqual(irisHeld, irisOpen * 0.5,
      "hold=1 iris \(irisHeld) should be ≤ 50% of no-hold iris \(irisOpen)")
  }

  // 4. Take turns even line (sideA=true) → left > right
  func testTakeTurnsSideALeftDominant() {
    let f = GlassMath.field(
      state: neutral(), intensity: .live, partyMode: "Take turns",
      sideA: true, cheer: 0, playing: true, reduceMotion: false,
      nextVocalIn: nil, inLongGap: false, wordKick: 0, previewSeconds: 1.5
    )
    XCTAssertGreaterThan(f.leftMeter, f.rightMeter)
  }

  // 5. Take turns odd line (sideA=false) → right > left
  func testTakeTurnsSideBRightDominant() {
    let f = GlassMath.field(
      state: neutral(), intensity: .live, partyMode: "Take turns",
      sideA: false, cheer: 0, playing: true, reduceMotion: false,
      nextVocalIn: nil, inLongGap: false, wordKick: 0, previewSeconds: 1.5
    )
    XCTAssertGreaterThan(f.rightMeter, f.leftMeter)
  }

  // 6. cheer adds to meters while playing == false
  func testCheerAddsToMetersWhenPaused() {
    let noCheer = GlassMath.field(
      state: neutral(), intensity: .live, partyMode: "Solo",
      sideA: true, cheer: 0, playing: false, reduceMotion: false,
      nextVocalIn: nil, inLongGap: false, wordKick: 0, previewSeconds: 1.5
    )
    let withCheer = GlassMath.field(
      state: neutral(), intensity: .live, partyMode: "Solo",
      sideA: true, cheer: 0.8, playing: false, reduceMotion: false,
      nextVocalIn: nil, inLongGap: false, wordKick: 0, previewSeconds: 1.5
    )
    XCTAssertGreaterThan(withCheer.leftMeter,  noCheer.leftMeter)
    XCTAssertGreaterThan(withCheer.rightMeter, noCheer.rightMeter)
  }

  // 7. breath: nextVocalIn=0.2, inLongGap=true → breath > 0.4
  func testBreathWithNearVocal() {
    let f = GlassMath.field(
      state: neutral(), intensity: .live, partyMode: "Solo",
      sideA: true, cheer: 0, playing: true, reduceMotion: false,
      nextVocalIn: 0.2, inLongGap: true, wordKick: 0, previewSeconds: 1.5
    )
    // breath = 1 - 0.2/0.40 = 0.5
    XCTAssertGreaterThan(f.breath, 0.4)
  }

  // 8. sleeve > 0 iff kind == .instrumental
  func testSleeveOnlyForInstrumental() {
    let inst = field(state: neutral(kind: .instrumental), intensity: .live)
    let verse = field(state: neutral(kind: .verse),       intensity: .live)
    let chorus = field(state: neutral(kind: .chorus),     intensity: .live)
    XCTAssertGreaterThan(inst.sleeve, 0)
    XCTAssertEqual(verse.sleeve, 0)
    XCTAssertEqual(chorus.sleeve, 0)
  }

  // 9. Warm gold artwork → non-nil, hue in 40–100°, L < 0.40
  func testFieldDominantWarmGold() {
    // #8C6A1F ≈ r=0.549, g=0.416, b=0.122
    let result = GlassMath.field(dominant: (r: 0.549, g: 0.416, b: 0.122))
    XCTAssertNotNil(result, "warm gold should produce a non-nil field color")
    if let rgb = result {
      let lch = RGB(r: rgb.r, g: rgb.g, b: rgb.b).oklch
      XCTAssertGreaterThanOrEqual(lch.h, 40, "hue \(lch.h) should be ≥ 40°")
      XCTAssertLessThanOrEqual(lch.h, 100, "hue \(lch.h) should be ≤ 100°")
      XCTAssertLessThan(lch.l, 0.40, "L \(lch.l) should be < 0.40")
    }
  }

  // 10. Greyscale art (r==g==b) → returns nil (chroma too low)
  func testFieldDominantGreyscaleReturnsNil() {
    XCTAssertNil(GlassMath.field(dominant: (r: 0.5, g: 0.5, b: 0.5)))
    XCTAssertNil(GlassMath.field(dominant: (r: 0.1, g: 0.1, b: 0.1)))
    XCTAssertNil(GlassMath.field(dominant: nil))
  }
}
