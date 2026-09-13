// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UsageMonitorMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "UsageMonitorMenu", targets: ["UsageMonitorMenu"]),
        .library(name: "QuotaCore", targets: ["QuotaCore"]),
    ],
    targets: [
        .target(name: "QuotaCore", linkerSettings: [.linkedLibrary("sqlite3")]),
        .executableTarget(
            name: "UsageMonitorMenu",
            dependencies: ["QuotaCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "QuotaCoreTests", dependencies: ["QuotaCore"]),
    ]
)
