import XCTest
@testable import Settings
@testable import AppCore
@testable import Networking
import Models

@MainActor
final class SettingsFeatureTests: XCTestCase {

    func testLiveVerifierUsesCookieFreeEphemeralSession() {
        let session = LiveTokenVerifier.makeCookieFreeSession()

        XCTAssertNil(session.configuration.httpCookieStorage)
        XCTAssertFalse(session.configuration.httpShouldSetCookies)
        XCTAssertEqual(session.configuration.httpCookieAcceptPolicy, .never)
    }

    private func makeEnv(token: String? = nil, host: String = "") -> AppEnvironment {
        let defaults = UserDefaults(suiteName: "test.settings.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.baseHost = host
        return AppEnvironment(settings: settings, tokenStore: InMemoryTokenStore(token: token))
    }

    // MARK: Token connection

    func testConnectPersistsTokenAfterSuccessfulVerification() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        vm.tokenInput = "  good-token  "

        await vm.connect()

        XCTAssertEqual(vm.phase, .verified)
        XCTAssertTrue(env.hasToken)
        XCTAssertEqual(vm.tokenInput, "", "The field is cleared once the token is safely stored.")
    }

    func testConnectRejectsBadTokenWithoutStoringIt() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.failure(.unauthorized)))
        vm.bind(to: env)
        vm.tokenInput = "wrong"

        await vm.connect()

        XCTAssertEqual(vm.phase, .failed(.unauthorized))
        XCTAssertFalse(env.hasToken, "A rejected token must never reach the Keychain.")
    }

    func testServerErrorDoesNotPersistUnverifiedToken() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.failure(.serverNotConfigured)))
        vm.bind(to: env)
        vm.tokenInput = "probably-fine"

        await vm.connect()
        XCTAssertEqual(vm.phase, .failed(.serverNotConfigured))
        XCTAssertFalse(env.hasToken)
    }

    func testConnectWithEmptyTokenFailsFast() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        vm.tokenInput = "   "

        await vm.connect()

        XCTAssertEqual(vm.phase, .failed(.missingToken))
        XCTAssertFalse(env.hasToken)
    }

    func testRemoveTokenClearsCredentialAndResets() {
        let env = makeEnv(token: "existing")
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        XCTAssertEqual(vm.phase, .configured, "A stored token is configured but not live-verified after relaunch.")

        vm.removeToken()

        XCTAssertFalse(env.hasToken)
        XCTAssertEqual(vm.phase, .idle)
    }

    // MARK: Host handling

    func testHostValidationAndResolvedDisplay() {
        let env = makeEnv()
        let vm = SettingsViewModel()
        vm.bind(to: env)

        XCTAssertTrue(vm.isHostValid, "Empty host is valid (means the production default).")
        XCTAssertEqual(vm.resolvedHostDisplay, "usage.jays.services")

        vm.hostInput = "staging.example.com"
        XCTAssertTrue(vm.isHostValid)
        XCTAssertEqual(vm.resolvedHostDisplay, "staging.example.com")
        XCTAssertTrue(vm.hostChanged)

        vm.hostInput = "http://"
        XCTAssertFalse(vm.isHostValid, "A URL with no host is rejected.")
    }

    func testApplyHostChangePersistsAndReconfigures() {
        let env = makeEnv(token: "tok")
        let vm = SettingsViewModel()
        vm.bind(to: env)
        vm.hostInput = "staging.example.com"
        XCTAssertTrue(vm.hostChanged)

        vm.applyHostChange()

        XCTAssertEqual(env.settings.baseHost, "staging.example.com")
        XCTAssertFalse(vm.hostChanged, "Once applied, the field matches the persisted host.")
    }

    // MARK: Formatting

    func testUptimeFormatting() {
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 273_600), "3d 4h")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 3_660), "1h 1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 90), "1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 30), "30s")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 0), "just started")
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

    // The free-tier kill-switch flag is only meaningful while R2 is the live
    // litestream target (role "active"). A stale/engaged flag left over from
    // an unrelated incident must not make an already-frozen "historic" R2
    // row claim "writes paused" next to its green OK badge.
    func testR2HistoricDetailIgnoresStaleKillSwitchFlag() {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    backupLayers: .init(
                        r2Historic: .init(
                            ok: true,
                            configured: true,
                            autoDisabled: true,
                            role: "historic"
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
        let detail = snapshot.backupLayerChecks.first { $0.name == "R2 Historic" }?.detail
        XCTAssertTrue(detail?.contains("weekly freeze") == true)
        XCTAssertFalse(detail?.contains("writes paused") == true)
    }

    func testDiskAndRateFormatting() {
        XCTAssertNotNil(DiskFormat.summary(free: 5_000_000_000, total: 20_000_000_000))
        XCTAssertNil(DiskFormat.summary(free: nil, total: 1))
        XCTAssertEqual(DiskFormat.cpuString(18.4), "18%")
        XCTAssertNotNil(DiskFormat.rateString(120_000))
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
