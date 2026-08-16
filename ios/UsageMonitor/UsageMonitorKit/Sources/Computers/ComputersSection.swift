import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Mac host heartbeat: CPU / memory / disk, issue flags, and process rows.
struct ComputersSection: View {
    let store: ComputersStore
    let onReload: @Sendable () async -> Void

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text("Mac")
                Spacer()
                if case let .loaded(health) = store.state {
                    StatusBadge(
                        statusLabel(health.status),
                        status: semanticStatus(health.status),
                        systemImage: health.ok ? "laptopcomputer" : "exclamationmark.triangle.fill"
                    )
                    .textCase(nil)
                }
            }
        } footer: {
            Text(footerText)
        }
    }

    private var footerText: String {
        if case let .loaded(health) = store.state, let ago = health.secondsSinceHeartbeat {
            return "Last heartbeat \(ago)s ago.  Pull to refresh."
        }
        return "CPU, memory, disk, and launchd flags from the Mac heartbeat.  Connect a read token or sign in if this is empty."
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let health = store.state.value {
                loaded(health)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 90, height: 12)
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
    private func loaded(_ health: MacHealthResponse) -> some View {
        if let mac = health.mac {
            LabeledContent("Name", value: mac.hostname)
            if let os = mac.osVersion {
                LabeledContent("System", value: os)
            }
            if let arch = mac.arch {
                LabeledContent("Chip", value: arch)
            }
            LabeledContent("Uptime", value: UptimeFormat.string(fromSeconds: mac.uptimeSeconds))

            LabeledContent("CPU", value: percent(mac.cpuUsagePct))
            LabeledContent("Memory", value: percent(mac.memoryUsagePct))
            LabeledContent("Disk", value: percent(mac.diskUsagePct))

            let flags = issueFlags(health)
            if flags.isEmpty {
                LabeledContent("Flags") {
                    StatusBadge("None", status: .ok, systemImage: "checkmark.circle.fill")
                }
            } else {
                Text("Flags")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(flags, id: \.self) { flag in
                    Label(flag, systemImage: "exclamationmark.triangle.fill")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.warning)
                }
            }

            let rows = mac.processRows
            if !rows.isEmpty {
                Text("Processes")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(rows, id: \.name) { row in
                    LabeledContent(shortProcessName(row.name)) {
                        StatusBadge(
                            processLabel(row.status),
                            status: processStatus(row.status),
                            systemImage: processStatus(row.status) == .ok
                                ? "checkmark.circle.fill"
                                : "exclamationmark.circle.fill"
                        )
                    }
                }
            }
        } else {
            Text("No Mac heartbeats yet.  The watchdog on the Mac has not checked in.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func percent(_ value: Double) -> String {
        String(format: "%.0f%%", value)
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "online": return "Online"
        case "degraded": return "High Load"
        case "offline": return "Offline"
        default: return status.capitalized
        }
    }

    private func semanticStatus(_ status: String) -> Theme.SemanticStatus {
        switch status {
        case "online": return .ok
        case "degraded": return .warning
        default: return .danger
        }
    }

    private func processLabel(_ status: String) -> String {
        switch status {
        case "running": return "Running"
        case "degraded": return "Degraded"
        case "stopped": return "Stopped"
        default: return status.capitalized
        }
    }

    private func processStatus(_ status: String) -> Theme.SemanticStatus {
        switch status {
        case "running": return .ok
        case "degraded": return .warning
        default: return .danger
        }
    }

    private func shortProcessName(_ name: String) -> String {
        name.replacingOccurrences(of: "com.jay.", with: "")
    }

    private func issueFlags(_ health: MacHealthResponse) -> [String] {
        var flags: [String] = []
        if health.status == "offline" {
            flags.append("Heartbeat stale — Mac looks offline.")
        }
        guard let mac = health.mac else { return flags }
        if mac.cpuUsagePct > 90 { flags.append("CPU above 90%.") }
        if mac.memoryUsagePct > 90 { flags.append("Memory above 90%.") }
        if mac.diskUsagePct > 95 { flags.append("Disk above 95%.") }
        for row in mac.processRows where row.status != "running" {
            flags.append("\(shortProcessName(row.name)) is \(row.status).")
        }
        return flags
    }
}
