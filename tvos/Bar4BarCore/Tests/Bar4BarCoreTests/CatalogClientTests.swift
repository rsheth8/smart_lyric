import XCTest
@testable import Bar4BarCore

/// Trimmed captures of the two live payloads. Keeping real shapes here rather
/// than hand-written minimal JSON is the point: the chart feed in particular is
/// deeply nested under colon-prefixed keys, which is exactly the kind of thing a
/// tidied-up fixture stops catching.
final class CatalogClientTests: XCTestCase {

  private let chartsJSON = """
  {"feed":{"entry":[
    {"im:name":{"label":"Choosin' Texas"},
     "im:image":[
       {"label":"https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/55x55bb.png","attributes":{"height":"55"}},
       {"label":"https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/60x60bb.png","attributes":{"height":"60"}},
       {"label":"https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/170x170bb.png","attributes":{"height":"170"}}],
     "im:collection":{"im:name":{"label":"Choosin' Texas - Single"}},
     "id":{"label":"https://music.apple.com/us/album/choosin-texas/1844932149?i=1844932150","attributes":{"im:id":"1844932150"}},
     "im:artist":{"label":"Ella Langley","attributes":{"href":"https://music.apple.com/us/artist/x"}}},
    {"im:name":{"label":"Been By Now"},
     "im:image":[{"label":"https://is1-ssl.mzstatic.com/image/thumb/x/170x170bb.png","attributes":{"height":"170"}}],
     "id":{"label":"https://music.apple.com/us/album/y","attributes":{"im:id":"1799999999"}},
     "im:artist":{"label":"Morgan Wallen"}}
  ]}}
  """.data(using: .utf8)!

  private let searchJSON = """
  {"resultCount":2,"results":[
    {"trackId":1844932150,"trackName":"Choosin' Texas","artistName":"Ella Langley",
     "collectionName":"Choosin' Texas - Single",
     "artworkUrl100":"https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/100x100bb.jpg",
     "trackTimeMillis":232226},
    {"trackId":1700000001,"trackName":"Dai Dai","artistName":"Shakira & Burna Boy",
     "artworkUrl100":"https://is1-ssl.mzstatic.com/image/thumb/z/100x100bb.jpg"}
  ]}
  """.data(using: .utf8)!

  // MARK: - Charts

  func testParsesChartEntries() {
    let items = CatalogClient.parseCharts(chartsJSON)
    XCTAssertEqual(items.count, 2)
    XCTAssertEqual(items[0].title, "Choosin' Texas")
    XCTAssertEqual(items[0].artist, "Ella Langley")
    XCTAssertEqual(items[0].album, "Choosin' Texas - Single")
  }

  /// The whole reason browse can hand off to MusicKit without a fuzzy match:
  /// `im:id` is the Apple Music catalog id, not an RSS-local identifier.
  func testChartIDIsTheAppleMusicCatalogID() {
    let items = CatalogClient.parseCharts(chartsJSON)
    XCTAssertEqual(items[0].id, "1844932150")
    // Same song, same id, from the other endpoint.
    XCTAssertEqual(CatalogClient.parseSearch(searchJSON)[0].id, "1844932150")
  }

  func testChartArtworkIsUpgradedFromTheLargestRendition() {
    let items = CatalogClient.parseCharts(chartsJSON)
    XCTAssertEqual(
      items[0].artworkURL?.absoluteString,
      "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/600x600bb.jpg"
    )
  }

  func testChartEntryWithoutACollectionStillParses() {
    let items = CatalogClient.parseCharts(chartsJSON)
    XCTAssertNil(items[1].album)
    XCTAssertEqual(items[1].title, "Been By Now")
  }

  func testMalformedChartFeedYieldsNothingRatherThanThrowing() {
    XCTAssertTrue(CatalogClient.parseCharts(Data("{\"feed\":{}}".utf8)).isEmpty)
    XCTAssertTrue(CatalogClient.parseCharts(Data("not json".utf8)).isEmpty)
  }

  // MARK: - Search

  func testParsesSearchResults() {
    let items = CatalogClient.parseSearch(searchJSON)
    XCTAssertEqual(items.count, 2)
    XCTAssertEqual(items[0].title, "Choosin' Texas")
    XCTAssertEqual(items[1].artist, "Shakira & Burna Boy")
  }

  /// Duration matters downstream: `LyricsClient.Query` scores candidate lyrics
  /// against it, so dropping it here would quietly worsen every match.
  func testSearchDurationConvertsMillisecondsToSeconds() {
    let items = CatalogClient.parseSearch(searchJSON)
    XCTAssertEqual(items[0].duration ?? 0, 232.226, accuracy: 1e-6)
    XCTAssertNil(items[1].duration)
  }

  func testSearchArtworkIsUpgraded() {
    let items = CatalogClient.parseSearch(searchJSON)
    XCTAssertEqual(
      items[0].artworkURL?.absoluteString,
      "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/aa/bb/cc.jpg/600x600bb.jpg"
    )
  }

  // MARK: - Artwork

  /// Both extensions have to be handled: the chart RSS serves `.png` URLs and
  /// Search serves `.jpg`, and the output is always `.jpg`.
  func testUpgradeNormalizesBothExtensionsToJPEG() {
    XCTAssertEqual(
      Artwork.upgrade("https://x/img/100x100bb.png")?.absoluteString,
      "https://x/img/600x600bb.jpg"
    )
    XCTAssertEqual(
      Artwork.upgrade("https://x/img/170x170bb.jpg")?.absoluteString,
      "https://x/img/600x600bb.jpg"
    )
  }

  func testUpgradeHonoursAnExplicitSize() {
    XCTAssertEqual(
      Artwork.upgrade("https://x/img/100x100bb.jpg", size: 260)?.absoluteString,
      "https://x/img/260x260bb.jpg"
    )
  }

  /// A URL that is not an iTunes rendition must pass through untouched rather
  /// than being mangled into a 404 — Spotify covers reach the same shelves.
  func testUpgradeLeavesNonITunesURLsAlone() {
    let spotify = "https://i.scdn.co/image/ab67616d0000b273abcdef"
    XCTAssertEqual(Artwork.upgrade(spotify)?.absoluteString, spotify)
  }

  func testUpgradeRejectsEmptyInput() {
    XCTAssertNil(Artwork.upgrade(nil))
    XCTAssertNil(Artwork.upgrade(""))
  }
}
