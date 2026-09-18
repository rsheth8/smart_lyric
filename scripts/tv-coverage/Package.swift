// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "TVCoverage",
  platforms: [.macOS(.v14)],
  dependencies: [.package(path: "../../tvos/Bar4BarCore")],
  targets: [.executableTarget(name: "TVCoverage", dependencies: [
    .product(name: "Bar4BarCore", package: "Bar4BarCore")
  ])]
)
