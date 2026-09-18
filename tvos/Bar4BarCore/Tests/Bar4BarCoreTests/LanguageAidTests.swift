import XCTest
@testable import Bar4BarCore

final class LineOverlayTests: XCTestCase {
  func testParseLRCSortsAndSkipsBlanks() {
    let out = LineOverlay.parseLRC("[00:12.50]Hello there\n[00:05.00]First line\n[bad]ignored\n[00:01.00]\n[ti:Title]\n[00:02.00]Real")
    XCTAssertEqual(out.map(\.start), [2, 5, 12.5])
    XCTAssertEqual(out.map(\.text), ["Real", "First line", "Hello there"])
  }

  func testAttachRomanByNearestStart() {
    var timeline = Timeline(lines: [
      LyricLine(start: 5, end: 8, words: [LyricWord(text: "夜", start: 5, end: 8)]),
      LyricLine(start: 10, end: 13, words: [LyricWord(text: "君", start: 10, end: 13)]),
    ], source: "yrc")
    let n = LineOverlay.attach("[00:05.00]yoru\n[00:10.00]kimi", as: .roman, to: &timeline)
    XCTAssertEqual(n, 2)
    XCTAssertEqual(timeline.lines[0].roman, "yoru")
    XCTAssertEqual(timeline.lines[1].roman, "kimi")
    XCTAssertTrue(timeline.hasRoman)
  }

  func testAttachLeavesFarLinesAloneAndSkipsCopies() {
    var far = Timeline(lines: [
      LyricLine(start: 50, end: 52, words: [LyricWord(text: "x", start: 50, end: 52)]),
    ])
    XCTAssertEqual(LineOverlay.attach("[00:05.00]hello", as: .english, to: &far), 0)
    XCTAssertNil(far.lines[0].english)

    var same = Timeline(lines: [
      LyricLine(start: 5, end: 7, words: [
        LyricWord(text: "la", start: 5, end: 6),
        LyricWord(text: "la", start: 6, end: 7),
      ]),
    ])
    XCTAssertEqual(LineOverlay.attach("[00:05.00]la la", as: .roman, to: &same), 0)
    XCTAssertNil(same.lines[0].roman)
    XCTAssertFalse(same.hasRoman)
  }
}

final class LanguageAidTests: XCTestCase {
  func testNeedsRomanizationDetectsNonLatinAndIgnoresLatin() {
    XCTAssertTrue(LanguageAid.needsRomanization(["तुम ही हो", "मेरी जान"]))
    XCTAssertTrue(LanguageAid.needsRomanization(["夜に駆ける", "君はまだ"]))
    XCTAssertTrue(LanguageAid.needsRomanization(["봄날", "보고 싶다"]))
    XCTAssertTrue(LanguageAid.needsRomanization(["ਤੂੰ ਹੀ ਹੈਂ", "ਮੇਰਾ ਦਿਲ"]))
    XCTAssertTrue(LanguageAid.needsRomanization(["আমি তোমায়"]))
    XCTAssertTrue(LanguageAid.needsRomanization(["நான் உன்னை"]))
    XCTAssertFalse(LanguageAid.needsRomanization(["Look at the stars", "How they shine for you"]))
    XCTAssertFalse(LanguageAid.needsRomanization(["Tum hi ho", "Meri jaan"]))
    XCTAssertFalse(LanguageAid.needsRomanization(["Café del mar", "Naïve"]))
  }

  func testCleanRomanStripsDiacritics() {
    XCTAssertEqual(LanguageAid.cleanRoman("Tū hī haiṁ"), "Tu hi haim")
    XCTAssertEqual(LanguageAid.cleanRoman("yoru ni kakeru"), "yoru ni kakeru")
  }

  func testLocalRomanizeTransliteratesAndSkipsLatin() {
    XCTAssertNil(LanguageAid.localRomanize("Look at the stars"))
    let hindi = LanguageAid.localRomanize("तुम ही हो")
    XCTAssertEqual(hindi, "tuma hi ho")
    XCTAssertFalse(LanguageAid.needsRomanization([hindi ?? ""]))
  }

  func testChunkLinesRespectsBudget() {
    let chunks = LanguageAid.chunkLines(["aaaa", "bbbb", "cccc"], maxChars: 10)
    XCTAssertEqual(chunks, [["aaaa", "bbbb"], ["cccc"]])
  }

  func testExtractTranslationJoinsSegments() {
    let json: [Any] = [[["Hello ", "こんにちは"], ["world", "世界"]]]
    XCTAssertEqual(LanguageAid.extractTranslation(from: json), "Hello world")
  }

  func testExtractRomanizationReadsTrailingSegment() {
    let json: [Any] = [[[NSNull(), NSNull(), NSNull(), "Tū hī haiṁ"]]]
    XCTAssertEqual(LanguageAid.extractRomanization(from: json), "Tu hi haim")
  }

  func testRealignPadsMissingRows() {
    XCTAssertEqual(LanguageAid.realign("one\ntwo", to: ["a", "b", "c"]), ["one", "two", ""])
  }

  func testModeOrderSkipsPronunciationWhenItDoesNotApply() {
    XCTAssertEqual(LanguageAidMode.next(from: .off, romanApplies: false), .english)
    XCTAssertEqual(LanguageAidMode.next(from: .english, romanApplies: false), .off)
    XCTAssertEqual(LanguageAidMode.next(from: .off, romanApplies: true), .roman)
    XCTAssertEqual(LanguageAidMode.next(from: .roman, romanApplies: true), .english)
    XCTAssertNil(LanguageAidMode.off.plateKind)
    XCTAssertEqual(LanguageAidMode.roman.plateKind, "SAY")
    XCTAssertEqual(LanguageAidMode.english.plateKind, "MEANING")
  }

  func testLanguageAidClientParsesMockedGooglePayload() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [GoogleTranslateProtocol.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let client = LanguageAidClient(session: session)
    let english = await client.translateLines(["こんにちは"], to: "en")
    XCTAssertEqual(english, ["Hello"])
    let roman = await client.romanizeLines(["こんにちは"])
    XCTAssertEqual(roman, ["konnichiwa"])
  }
}

private final class GoogleTranslateProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let dt = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "dt" }?.value
    let body: String
    if dt == "rm" {
      body = #"[[[null,null,null,"konnichiwa"]]]"#
    } else {
      body = #"[[["Hello","こんにちは",null,null,0]]]"#
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
