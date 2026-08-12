import XCTest
@testable import ServerStatus
@testable import AppCore
@testable import Networking
import DesignSystem
import Models

/// Server-status snapshot roll-ups, store lifecycle, and the shared
/// uptime/disk formatters. Moved from `SettingsFeatureTests` when the panel
/// became its own tab (ServerStatus lane).
@MainActor
final class ServerStatusFeatureTests: XCTestCase {

    // MARK: Formatting

    func testUptimeFormatting() {
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 273_600), "3d 4h")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 3_660), "1h 1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 90), "1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 30), "30s")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 0), "just started")
    }

    func testDiskAndRateFormatting() {
        XCTAssertNotNil(DiskFormat.summary(free: 5_000_000_000, total: 20_000_000_000))
        XCTAssertNil(DiskFormat.summary(free: nil, total: 1))
        XCTAssertEqual(DiskFormat.cpuString(18.4), "18%")
        XCTAssertNotNil(DiskFormat.rateString(120_000))
    }

    // MARK: Server status

    func testSnapshotRollupsAndDependencyRows() {
        let degraded = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: false,
                status: "degraded",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: false),
                    backup: .init(ok: false)
                )
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(degraded.overallStatus, .warning)
        XCTAssertEqual(degraded.overallLabel, "Degraded")
        // Core service rows only; legacy single backup lands in backupLayerChecks.
        XCTAssertEqual(degraded.dependencyChecks.count, 2)
        XCTAssertEqual(
            degraded.dependencyChecks.map(\.name),
            ["Database", "Scheduler"]
        )
        let legacyBackup = degraded.backupLayerChecks.first { $0.name == "Backup (Off-Site)" }
        XCTAssertNotNil(legacyBackup)
        XCTAssertEqual(legacyBackup?.ok, false)
        XCTAssertEqual(legacyBackup?.gatesService, false)

        let layered = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: true),
                    startup: .init(ok: true),
                    disk: .init(ok: true, freeBytes: 10_000_000_000, totalBytes: 100_000_000_000),
                    backupLayers: .init(
                        local: .init(ok: true, present: true, count: 2, latestAgeSeconds: 7200),
                        primary: .init(
                            ok: true,
                            target: "b2",
                            label: "b2",
                            active: true,
                            replicaAgeSeconds: 90
                        ),
                        r2Historic: .init(ok: true, configured: true, role: "historic")
                    )
                )
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(
            layered.dependencyChecks.map(\.name),
            ["Database", "Scheduler", "Startup", "Disk"]
        )
        XCTAssertEqual(
            layered.backupLayerChecks.map(\.name),
            ["Local Backup", "B2 Backup", "R2 Historic"]
        )
        XCTAssertTrue(layered.backupLayerChecks.allSatisfy(\.ok))
        XCTAssertTrue(layered.backupLayerChecks.allSatisfy { !$0.gatesService })
        XCTAssertTrue(
            layered.backupLayerChecks.first { $0.name == "Local Backup" }?.detail?
                .contains("2 snapshots") == true
        )
        XCTAssertTrue(
            layered.backupLayerChecks.first { $0.name == "R2 Historic" }?.detail?
                .contains("weekly freeze") == true
        )

        let down = ServerStatusSnapshot(
            health: .init(ok: false, status: "fail"),
            readiness: nil,
            fetchedAt: Date()
        )
        XCTAssertEqual(down.overallStatus, .danger)
        XCTAssertEqual(down.overallLabel, "Offline")
        XCTAssertTrue(down.dependencyChecks.isEmpty)
        XCTAssertTrue(down.backupLayerChecks.isEmpty)
    }

    func testServerStatusStoreLoadsViaProbe() async {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok", version: "1.0.0"),
            readiness: nil,
            fetchedAt: Date()
        )
        let store = ServerStatusStore(probe: { _ in snapshot })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.value, snapshot)
    }

    func testServerStatusStoreSurfacesTypedError() async {
        let store = ServerStatusStore(probe: { _ in throw APIError.offline })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.error, .offline)
    }
}
