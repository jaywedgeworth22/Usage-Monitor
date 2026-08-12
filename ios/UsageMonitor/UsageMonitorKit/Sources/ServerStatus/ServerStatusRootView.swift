import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// The **Server Status** feature root (owned by the ServerStatus lane).
///
/// The live health/readiness panel that used to be a Settings section, now a
/// first-class tab. Hits only the **public** probes (`/api/health`,
/// `/api/ready`) so it renders before any token is entered — "my token is
/// wrong" stays distinguishable from "the server is down".
///
/// Contract: keeps `public struct ServerStatusRootView: View` + `public
/// init()`, owns its own `NavigationStack` + title, and reads everything
/// through `@Environment(AppEnvironment.self)`.
public struct ServerStatusRootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var status: ServerStatusStore

    public init() {
        _status = State(initialValue: ServerStatusStore())
    }

    /// Preview/test seam — inject a stubbed status store.
    init(status: ServerStatusStore) {
        _status = State(initialValue: status)
    }

    public var body: some View {
        NavigationStack {
            Form {
                ServerStatusSection(store: status) {
                    await status.refresh(using: env.apiClient)
                }
            }
            .navigationTitle(AppTab.serverStatus.title)
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await status.loadIfNeeded(using: env.apiClient)
            }
            .refreshable {
                await status.refresh(using: env.apiClient)
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
