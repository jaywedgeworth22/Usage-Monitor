import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Hetzner host utilization (whole server) plus Coolify app resources,
/// highlighting Usage Monitor's own app row. Requires read token / session.
struct HostUsageSection: View {
    let store: HostUsageStore
    let hasCredential: Bool
    let onReload: @Sendable () async -> Void

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text("Host Usage")
                Spacer()
                if case let .loaded(metrics) = store.state {
                    StatusBadge(
                        metrics.stale ? "Stale" : (metrics.degraded ? "Degraded" : "Live"),
                        status: metrics.stale || metrics.degraded ? .warning : .ok,
                        systemImage: metrics.stale || metrics.degraded
                            ? "exclamationmark.triangle.fill"
                            : "server.rack"
                    )
                    .textCase(nil)
                }
            }
        } footer: {
            Text(footerText)
        }
    }

    private var footerText: String {
        if !hasCredential {
            return "Connect a read token or sign in with the dashboard password to load Hetzner host metrics."
        }
        if case let .loaded(metrics) = store.state, let asOf = metrics.asOf {
            return "Host-wide CPU and network from Hetzner · app list from Coolify · checked \(asOf)."
        }
        return "Host-wide CPU and network from Hetzner · app list from Coolify."
    }

    @ViewBuilder
    private var content: some View {
        if !hasCredential {
            Text("Sign in or add a read token to see host usage.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        } else {
            switch store.state {
            case let .failed(error):
                failure(error)
            default:
                if let metrics = store.state.value {
                    loaded(metrics)
                } else {
                    skeleton
                }
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 100, height: 12)
                Spacer()
                SkeletonBlock(width: 48, height: 12)
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(error.title)
                .font(Theme.Typography.captionEmphasis)
            Text(error.message)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            Button {
                Task { await onReload() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .tint(Theme.Colors.accent)
        }
    }

    @ViewBuilder
    private func loaded(_ metrics: ServerMetrics) -> some View {
        // Whole-server block
        Text("Server")
            .font(Theme.Typography.captionEmphasis)
            .foregroundStyle(Theme.Colors.secondaryText)
            .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 2, trailing: 20))
            .accessibilityAddTraits(.isHeader)

        if let host = metrics.host {
            if let name = host.name {
                LabeledContent("Name", value: name)
            }
            if let type = host.serverType, let cpus = host.cpus {
                LabeledContent("Type", value: "\(type) · \(cpus) vCPU")
            } else if let type = host.serverType {
                LabeledContent("Type", value: type)
            }
            if let mem = host.memoryTotalBytes {
                LabeledContent("Memory", value: DiskFormat.byteString(mem))
            }
            if let status = host.status {
                LabeledContent("Status", value: status.capitalized)
            }
            if let window = host.backupWindow {
                LabeledContent("Hetzner Backups", value: "Daily \(window) UTC")
            }
        }

        if let usage = metrics.hostUsage {
            if let cpu = DiskFormat.cpuString(usage.cpuPct) {
                LabeledContent("CPU", value: cpu)
            }
            if let rx = DiskFormat.rateString(usage.networkRxBytesPerSec),
               let tx = DiskFormat.rateString(usage.networkTxBytesPerSec) {
                LabeledContent("Network", value: "↓ \(rx) · ↑ \(tx)")
            }
            if let read = DiskFormat.rateString(usage.diskReadBytesPerSec),
               let write = DiskFormat.rateString(usage.diskWriteBytesPerSec) {
                LabeledContent("Disk I/O", value: "R \(read) · W \(write)")
            }
        }

        // This app
        Text("This App")
            .font(Theme.Typography.captionEmphasis)
            .foregroundStyle(Theme.Colors.secondaryText)
            .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
            .accessibilityAddTraits(.isHeader)

        if let selfApp = metrics.selfResources.first {
            LabeledContent(selfApp.fleetLabel ?? selfApp.name) {
                StatusBadge(
                    resourceLabel(selfApp.status),
                    status: resourceStatus(selfApp.status),
                    systemImage: resourceStatus(selfApp.status) == .ok
                        ? "checkmark.circle.fill"
                        : "exclamationmark.circle.fill"
                )
            }
        } else {
            Text("Usage Monitor app not listed by Coolify.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }

        if let disk = metrics.appDisk {
            if let free = disk.freeBytes, let total = disk.totalBytes {
                LabeledContent("App Disk") {
                    Text(DiskFormat.summary(free: free, total: total) ?? "—")
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            if let used = disk.usedPct {
                LabeledContent("App Disk Used", value: "\(used)%")
            }
        }

        // Fleet backups (summary + open detail for ST / CT / UM locations)
        if let fleet = metrics.fleetBackups, !fleet.apps.isEmpty {
            Text("Fleet Backups")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.secondaryText)
                .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                .accessibilityAddTraits(.isHeader)

            ForEach(fleet.apps) { app in
                LabeledContent(app.label) {
                    StatusBadge(
                        app.ok == false ? "Lagging" : "OK",
                        status: app.ok == false ? .warning : .ok,
                        systemImage: app.ok == false ? "exclamationmark" : "checkmark"
                    )
                }
                if let summary = appBackupSummary(app) {
                    Text(summary)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }

            NavigationLink {
                FleetBackupDetailView(fleet: fleet)
            } label: {
                Label("Open Backup Locations", systemImage: "externaldrive.badge.timemachine")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
        }

        // All apps on the host (runtime status + linked backup flag when known)
        let others = metrics.resources.filter { !$0.selfApp }
        if !others.isEmpty {
            Text("All Apps On Host")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.secondaryText)
                .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                .accessibilityAddTraits(.isHeader)

            ForEach(others) { resource in
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    LabeledContent(resource.fleetLabel ?? resource.name) {
                        StatusBadge(
                            resourceLabel(resource.status),
                            status: resourceStatus(resource.status),
                            systemImage: resourceStatus(resource.status) == .ok
                                ? "checkmark"
                                : "exclamationmark"
                        )
                    }
                    if let backupLine = linkedBackupLine(
                        fleetAppId: resource.fleetAppId,
                        fleet: metrics.fleetBackups
                    ) {
                        Text(backupLine)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Text(resource.type.capitalized)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(resource.fleetLabel ?? resource.name): \(resourceLabel(resource.status))"
                )
            }
        }

        if let error = metrics.error, !error.isEmpty {
            Text(error)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.warning)
        }
    }

    private func appBackupSummary(_ app: ServerMetrics.FleetBackups.App) -> String? {
        let present = app.locations.filter { $0.present == true || $0.ok == true }
        guard !present.isEmpty else {
            return app.locations.first?.reason.map { humanReason($0) }
        }
        let parts = present.prefix(3).map { loc -> String in
            if let age = loc.latestAgeSeconds {
                return "\(loc.label) \(UptimeFormat.string(fromSeconds: Int(age))) ago"
            }
            return loc.label
        }
        return parts.joined(separator: " · ")
    }

    private func linkedBackupLine(
        fleetAppId: String?,
        fleet: ServerMetrics.FleetBackups?
    ) -> String? {
        guard let fleetAppId, let fleet else { return nil }
        guard let app = fleet.apps.first(where: { $0.id == fleetAppId }) else { return nil }
        return appBackupSummary(app).map { "Backups: \($0)" }
    }

    private func humanReason(_ reason: String) -> String {
        reason
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "b2 ", with: "B2 ")
    }

    private func resourceLabel(_ status: String) -> String {
        let lower = status.lowercased()
        if lower.contains("healthy") || lower == "running" { return "Healthy" }
        if lower.contains("unknown") { return "Unknown" }
        if lower.contains("degraded") || lower.contains("unhealthy") { return "Degraded" }
        if lower.contains("exited") || lower.contains("stopped") { return "Stopped" }
        return status
    }

    private func resourceStatus(_ status: String) -> Theme.SemanticStatus {
        let lower = status.lowercased()
        if lower.contains("healthy") || lower == "running" { return .ok }
        if lower.contains("unknown") { return .warning }
        if lower.contains("degraded") || lower.contains("unhealthy") { return .warning }
        if lower.contains("exited") || lower.contains("stopped") { return .danger }
        return .warning
    }
}
