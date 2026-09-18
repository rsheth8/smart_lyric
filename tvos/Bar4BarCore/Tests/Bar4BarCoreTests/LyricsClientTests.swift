import XCTest
@testable import Bar4BarCore

final class LyricsClientTests: XCTestCase {
  private func client() -> LyricsClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CatalogLyricsProtocol.self]
    return LyricsClient(apiBaseURL: URL(string: "https://lyrics.test"), session: URLSession(configuration: config))
  }

  func testWordTimingAndActualProviderMetadataSurviveFetch() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let result = await client.fetch(.init(artist: "Test", track: "Right Song", duration: 30))
    XCTAssertTrue(result?.timeline.hasWordTiming == true)
    XCTAssertEqual(result?.meta.track, "Right Song")
    XCTAssertEqual(result?.timeline.lines.first?.words.first?.end, 1.5)
  }

  func testPreparedAudioTimingsReachTheTVClient() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let result = await client.fetch(.init(artist: "Test", track: "Prepared Song", duration: 30))
    XCTAssertEqual(result?.timeline.source, "aligned")
    XCTAssertEqual(result?.timeline.lines[0].words[0].start, 1.2)
  }

  func testWrongSongWithRichTimingCannotWin() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let result = await client.fetch(.init(artist: "Test", track: "Different Song", duration: 30))
    XCTAssertEqual(result?.timeline.source, "lrclib")
    XCTAssertFalse(result?.timeline.hasWordTiming ?? true)
    XCTAssertEqual(result?.meta.track, "Different Song")
  }

  func testPreparedRecordingIDIsSentAndConflictingEditionIsRejected() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let matched = await client.fetch(.init(artist: "Test", track: "Prepared Song", duration: 30,
      recording: .init(spotifyID: "recording-a", explicit: true)))
    XCTAssertEqual(matched?.timeline.source, "aligned")
    let wrong = await client.fetch(.init(artist: "Test", track: "Prepared Song", duration: 30,
      recording: .init(spotifyID: "recording-b", explicit: true)))
    XCTAssertNil(wrong)
    let clean = await client.fetch(.init(artist: "Test", track: "Prepared Song", duration: 30,
      recording: .init(spotifyID: "recording-a", explicit: false)))
    XCTAssertNil(clean)
  }

  func testRichsyncUsesRecordingIdentifiersAndStaysUncachedWhenLicensed() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let result = await client.fetch(.init(artist: "Test", track: "Licensed Song", duration: 30,
      recording: .init(spotifyID: "sp-licensed", isrc: "USABC2600001")))
    XCTAssertEqual(result?.timeline.source, "richsync")
    XCTAssertEqual(result?.timeline.lines.first?.words.first?.text, "hi")
    XCTAssertFalse(result?.cacheable ?? true)
  }

  func testNeteaseRomanizationAttachesToWordTimeline() async {
    let client = client()
    defer { client.session.invalidateAndCancel() }
    let result = await client.fetch(.init(artist: "Test", track: "Night Runner", duration: 30))
    XCTAssertEqual(result?.timeline.source, "yrc")
    XCTAssertEqual(result?.timeline.lines.first?.roman, "yoru ni")
    XCTAssertTrue(result?.timeline.hasRoman == true)
  }

  func testOfficialOnlyAcceptsLicensedRichsyncAndRejectsCommunityFallbacks() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CatalogLyricsProtocol.self]
    let client = LyricsClient(
      apiBaseURL: URL(string: "https://lyrics.test"),
      session: URLSession(configuration: config),
      officialOnly: true
    )
    defer { client.session.invalidateAndCancel() }

    let licensed = await client.fetch(.init(
      artist: "Test", track: "Licensed Song", duration: 30,
      recording: .init(spotifyID: "sp-licensed", isrc: "USABC2600001")
    ))
    XCTAssertEqual(licensed?.timeline.source, "richsync")
    XCTAssertFalse(licensed?.cacheable ?? true)

    let communityOnly = await client.fetch(.init(artist: "Test", track: "Different Song", duration: 30))
    XCTAssertNil(communityOnly)
  }
}

private final class CatalogLyricsProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body: String
    switch request.url!.path {
    case "/api/lyrics":
      let track = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == "track" }?.value
      if track == "Night Runner" {
        body = #"{"yrc":"[1000,3000](1000,500,0)夜 (2000,500,0)に","rlrc":"[00:01.00]yoru ni","meta":{"trackName":"Night Runner","artistName":"Test","duration":30}}"#
      } else {
        body = #"{"yrc":"[1000,3000](1000,500,0)Hello (2000,500,0)world","meta":{"trackName":"Right Song","artistName":"Test","duration":30}}"#
      }
    case "/api/richsync":
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let hasID = query.contains { $0.name == "spotifyID" || $0.name == "isrc" }
      body = hasID
        ? #"{"richsync":"[{\"ts\":1,\"te\":2,\"x\":\"hi\",\"l\":[{\"c\":\"hi\",\"o\":0}]}]","licensed":true,"cacheable":false,"meta":{"trackName":"Licensed Song","artistName":"Test","duration":30}}"#
        : "{}"
    case "/api/word-timings":
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let identity = query.contains { $0.name == "spotifyID" }
        ? #", "recording":{"spotifyID":"recording-a","explicit":true}"# : ""
      body = #"{"version":1,"meta":{"track":"Prepared Song","artist":"Test","duration":30"# + identity + #"},"timeline":{"source":"aligned","estimated":false,"duration":30,"lines":[{"start":1.2,"end":2,"uncertain":false,"words":[{"text":"Hello","start":1.2,"end":2,"score":0.9}]}]}}"#
    case "/api/search":
      body = #"[{"trackName":"Different Song","artistName":"Test","duration":30,"syncedLyrics":"[00:01.00]Different words"}]"#
    default: body = "{}"
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
