// swift-tools-version: 6.0
// SwiftPM manifest for xtool (`xtool dev build --ipa` on Linux). Xcode builds use project.yml instead.

import PackageDescription

let package = Package(
    name: "InfiniteOC",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        // xtool builds the app from the package's single library product.
        .library(name: "InfiniteOC", targets: ["InfiniteOC"]),
    ],
    targets: [
        .target(
            name: "InfiniteOC",
            path: "InfiniteOC",
            // xtool's build has no asset catalog compiler: the icon comes from xtool.yml, the mark from Resources.
            exclude: ["Info.plist", "Assets.xcassets"],
            resources: [.copy("Resources/mark.png")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
