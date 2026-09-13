// swift-tools-version:5.10
// Everything the tvOS app does that isn't a view: lyric parsing, catalog and
// lyrics fetching, the phone-remote protocol. Ported from the web app (app/) so
// both speak the same relay and read lyrics the same way; runs `swift test` on a Mac.
import PackageDescription

let package = Package(
  name: "Bar4BarKit",
  platforms: [.tvOS(.v17), .macOS(.v14)],
  products: [.library(name: "Bar4BarKit", targets: ["Bar4BarKit"])],
  targets: [
    .target(name: "Bar4BarKit"),
    .testTarget(name: "Bar4BarKitTests", dependencies: ["Bar4BarKit"]),
  ]
)
