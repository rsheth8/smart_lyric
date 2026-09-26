// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "Bar4BarCore",
  platforms: [
    .tvOS(.v17),
    .macOS(.v14),
    .iOS(.v17),
  ],
  products: [
    .library(name: "Bar4BarCore", targets: ["Bar4BarCore"]),
  ],
  targets: [
    .target(name: "Bar4BarCore",
            resources: [.copy("Resources/WordTimer.mlpackage")]),
    .testTarget(
      name: "Bar4BarCoreTests",
      dependencies: ["Bar4BarCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
