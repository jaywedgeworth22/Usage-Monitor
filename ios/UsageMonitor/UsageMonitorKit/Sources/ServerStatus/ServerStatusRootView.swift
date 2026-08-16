import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// The **Server Status** feature root (owned by the ServerStatus lane).
///
/// Public health/readiness first (`/api/health`, `/api/ready`) so a missing
/// token is distinguishable from a down host.  Host Usage (Hetzner + Coolify +
/// fleet backups) follows as its own grouped sections on this tab — not buried
/// in Settings.
///
/// Contract: keeps `public struct ServerStatusRootView: View` + `public
/// init()`, owns its own `NavigationStack` + title, and reads everything
/// through `@Environment(AppEnvironment.self)`.
public struct ServerStatusRootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var status: ServerStatusStore
    @State private var hostUsage: HostUsageStore

    public init() {
        _status = State(initialValue: ServerStatusStore())
        _hostUsage = State(initialValue: HostUsageStore())
    }

    /// Preview/test seam — inject a stubbed status store.
    init(status: ServerStatusStore) {
        _status = State(initialValue: status)
        _hostUsage = State(initialValue: HostUsageStore())
    }

    public var body: some View {
        NavigationStack {
            Form {
                ServerStatusSection(store: status) {
                    await status.refresh(using: env.apiClient)
                }
                HostUsageSection(
                    store: hostUsage,
                    hasCredential: env.hasToken
                ) {
                    await hostUsage.refresh(using: env.apiClient)
                }
            }
            .navigationTitle(AppTab.serverStatus.title)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: env.accessIdentityRevision) {
                await status.loadIfNeeded(using: env.apiClient)
                hostUsage.reset()
                if env.hasToken {
                    await hostUsage.loadIfNeeded(using: env.apiClient)
                }
            }
            .refreshable {
                await status.refresh(using: env.apiClient)
                if env.hasToken {
                    await hostUsage.refresh(using: env.apiClient)
                }
            }
        }
    }
}

// MARK: - Previews

#Preview("Healthy — Light") {
    ServerStatusRootView(status: ServerStatusStore(probe: PreviewProbe.healthy))
        .environment(AppEnvironment.preview(token: nil))
        .preferredColorScheme(.light)
}

#Preview("Degraded — Dark") {
    ServerStatusRootView(status: ServerStatusStore(probe: PreviewProbe.degraded))
        .environment(AppEnvironment.preview(token: "verified-token"))
        .preferredColorScheme(.dark)
}

/// Deterministic probes for the SwiftUI canvas (no network).
enum PreviewProbe {
    static let healthy: @Sendable (Networking.APIClient) async throws -> ServerStatusSnapshot = { _ in
        try? await Task.sleep(nanoseconds: 200_000_000)
        return ServerStatusSnapshot(
            health: .init(
                ok: true,
                status: "ok",
                uptimeSeconds: 273_600,
                service: "usage-monitor",
                version: "1.8.2",
                commit: "fe6d9c6d1a"
            ),
            readiness: .sample,
            fetchedAt: Date()
        )
    }

    static let degraded: @Sendable (Networking.APIClient) async throws -> ServerStatusSnapshot = { _ in
        ServerStatusSnapshot(
            health: .init(ok: true, status: "ok", uptimeSeconds: 3_600, service: "usage-monitor", version: "1.8.2"),
            readiness: .init(
                ok: false,
                status: "degraded",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: false),
                    backup: .init(ok: true),
                    backupLayers: .init(
                        local: .init(ok: true, present: true, count: 1),
                        primary: .init(ok: false, target: "b2", label: "b2", reason: "replica_status_stale"),
                        r2Historic: .init(
                            ok: false,
                            configured: true,
                            role: "historic",
                            reason: "archive_not_run"
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
    }
}
