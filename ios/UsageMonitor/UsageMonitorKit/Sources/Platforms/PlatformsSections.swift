import DesignSystem
import Models
import SwiftUI

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

enum PlatformFormat {
    static func bytes(_ value: Int64?) -> String {
        guard let value else { return "—" }
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var amount = Double(max(0, value))
        var unit = 0
        while amount >= 1024, unit < units.count - 1 {
            amount /= 1024
            unit += 1
        }
        return String(format: unit >= 3 ? "%.1f %@" : "%.0f %@", amount, units[unit])
    }

    static func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.0f%%", value)
    }

    static func age(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "Never" }
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// The Hetzner box itself: size, CPU pressure, disk headroom, and whatever the
/// prevention panel is currently worried about.
struct FleetHostSection: View {
    let metrics: ServerMetrics

    private var cpuStatus: Theme.SemanticStatus {
        guard let peak = metrics.prevention?.summary?.cpuPeakPct else { return .neutral }
        if peak >= 90 { return .danger }
        if peak >= 70 { return .warning }
        return .ok
    }

    private var diskStatus: Theme.SemanticStatus {
        guard let used = metrics.appDisk?.usedPct else { return .neutral }
        if used >= 90 { return .danger }
        if used >= 75 { return .warning }
        return .ok
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Host", subtitle: hostSubtitle)

            HStack(spacing: Theme.Spacing.md) {
                StatTile(
                    label: "CPU Now",
                    value: PlatformFormat.percent(metrics.hostUsage?.cpuPct),
                    secondary: metrics.prevention?.summary?.cpuPeakPct
                        .map { "Peak \(PlatformFormat.percent($0))" },
                    systemImage: "cpu",
                    status: cpuStatus
                )
                StatTile(
                    label: "Disk Used",
                    value: metrics.appDisk?.usedPct.map { "\($0)%" } ?? "—",
                    secondary: "\(PlatformFormat.bytes(metrics.appDisk?.freeBytes)) free",
                    systemImage: "internaldrive",
                    status: diskStatus
                )
            }

            if let indicators = metrics.prevention?.indicators, !indicators.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(indicators) { indicator in
                        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                            StatusBadge(
                                indicator.label,
                                status: indicator.severity == "critical" ? .danger : .warning
                            )
                            Text(indicator.detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var hostSubtitle: String? {
        guard let host = metrics.host else { return nil }
        let parts = [host.name, host.serverType, host.location].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// ---------------------------------------------------------------------------
// Fleet apps
// ---------------------------------------------------------------------------

/// Every Coolify application on the host, for all fleet apps — not just this
/// one.  An app Coolify reports as running but cannot health-check shows as
/// "Unknown" rather than being quietly counted as healthy.
struct FleetAppsSection: View {
    let metrics: ServerMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Fleet Apps", subtitle: "\(metrics.resources.count) on this host")

            ForEach(metrics.resources) { resource in
                HStack(spacing: Theme.Spacing.sm) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(resource.fleetLabel ?? resource.name)
                            .font(Theme.Typography.body)
                            .foregroundStyle(Theme.Colors.primaryText)
                        Text(resource.status)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer(minLength: Theme.Spacing.sm)
                    StatusBadge(statusTitle(resource.status), status: status(for: resource.status))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func status(for raw: String) -> Theme.SemanticStatus {
        let value = raw.lowercased()
        if value.contains("unknown") { return .warning }
        if value.contains("healthy") || value.contains("running") { return .ok }
        if value.contains("exited") || value.contains("stopped") { return .danger }
        return .neutral
    }

    private func statusTitle(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("unknown") { return "Unknown" }
        if value.contains("healthy") { return "Healthy" }
        if value.contains("running") { return "Running" }
        if value.contains("exited") || value.contains("stopped") { return "Down" }
        return "Unknown"
    }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/// Per-app, per-location backup coverage across the whole fleet.
struct FleetBackupsSection: View {
    let metrics: ServerMetrics

    var body: some View {
        if let backups = metrics.fleetBackups, !backups.apps.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader("Backups", subtitle: "Off-site and local coverage")

                ForEach(backups.apps) { app in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(app.label)
                            .font(Theme.Typography.captionEmphasis)
                            .foregroundStyle(Theme.Colors.primaryText)
                        ForEach(app.locations) { location in
                            HStack(spacing: Theme.Spacing.sm) {
                                Text(location.label)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                Spacer(minLength: Theme.Spacing.sm)
                                Text(locationDetail(location))
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                StatusBadge(
                                    locationTitle(location),
                                    status: locationStatus(location)
                                )
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsCard()
        }
    }

    private func locationDetail(_ location: ServerMetrics.FleetBackups.Location) -> String {
        if location.present == false { return "" }
        return PlatformFormat.age(location.latestAgeSeconds)
    }

    private func locationTitle(_ location: ServerMetrics.FleetBackups.Location) -> String {
        if location.present == false { return "Not Configured" }
        if location.ok == true { return "OK" }
        if location.ok == false { return "Lagging" }
        return "Unknown"
    }

    private func locationStatus(
        _ location: ServerMetrics.FleetBackups.Location
    ) -> Theme.SemanticStatus {
        if location.present == false { return .neutral }
        if location.ok == true { return .ok }
        if location.ok == false { return .warning }
        return .neutral
    }
}

// ---------------------------------------------------------------------------
// Operations rollup
// ---------------------------------------------------------------------------

/// The `/api/operations` half of the web Ops page: peer app health, R2 free
/// tier, receipt inbox.  Previously unreachable from iOS at all.
struct FleetOperationsSection: View {
    let operations: OperationsHealth

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Operations")

            if let peer = operations.socraticInfrastructure {
                row(
                    title: "Peer App Health",
                    detail: peer.releaseSha.map { String($0.prefix(8)) } ?? "—",
                    state: peer.state
                )
            }

            if let inbox = operations.receiptInbox {
                row(
                    title: "Receipt Inbox",
                    detail: inbox.needsReviewCount.map { "\($0) to review" } ?? "—",
                    state: inbox.state
                )
            }

            if let r2 = operations.r2Fleet, r2.configured {
                ForEach(r2.accounts) { account in
                    HStack(spacing: Theme.Spacing.sm) {
                        Text(account.label ?? account.id)
                            .font(Theme.Typography.body)
                            .foregroundStyle(Theme.Colors.primaryText)
                        Spacer(minLength: Theme.Spacing.sm)
                        Text(PlatformFormat.percent(account.storage?.mtdPct))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                        StatusBadge(
                            account.overallOnTrackToExceed70Pct ? "Watch" : "OK",
                            status: account.overallOnTrackToExceed70Pct ? .warning : .ok
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    @ViewBuilder
    private func row(title: String, detail: String, state: OperationsHealth.State) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer(minLength: Theme.Spacing.sm)
            Text(detail)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            StatusBadge(state.title, status: semantic(state))
        }
    }

    private func semantic(_ state: OperationsHealth.State) -> Theme.SemanticStatus {
        switch state {
        case .healthy, .receiving: return .ok
        case .degraded, .stale: return .warning
        case .unavailable, .unreachable: return .danger
        case .unconfigured: return .neutral
        }
    }
}

// ---------------------------------------------------------------------------
// Platform cards
// ---------------------------------------------------------------------------

/// One card per external platform, grouped by category in the server's order.
struct PlatformCardsSection: View {
    let payload: PlatformStatusPayload

    var body: some View {
        ForEach(payload.groupedByCategory, id: \.category) { group in
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(group.category.title)
                ForEach(group.platforms) { platform in
                    PlatformCardRow(platform: platform)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsCard()
        }
    }
}

struct PlatformCardRow: View {
    let platform: PlatformStatusPayload.PlatformCard

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(platform.name)
                    .font(Theme.Typography.body)
                    .foregroundStyle(
                        platform.configured
                            ? Theme.Colors.primaryText : Theme.Colors.secondaryText
                    )
                Spacer(minLength: Theme.Spacing.sm)
                StatusBadge(platform.state.title, status: semantic(platform.state))
            }

            if let headline = platform.headline, !headline.isEmpty {
                Text(headline)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if platform.configured, !platform.metrics.isEmpty {
                ForEach(platform.metrics) { entry in
                    HStack(spacing: Theme.Spacing.sm) {
                        Text(entry.label)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                        Spacer(minLength: Theme.Spacing.sm)
                        Text(entry.hint.map { "\(entry.value) \($0)" } ?? entry.value)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }

            if !platform.configured, let first = platform.requiredEnv.first {
                Text("Set \(first) to enable.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
    }

    private func semantic(_ state: PlatformStatusPayload.State) -> Theme.SemanticStatus {
        switch state {
        case .healthy, .receiving: return .ok
        case .degraded, .stale: return .warning
        case .unavailable, .unreachable: return .danger
        case .unconfigured: return .neutral
        }
    }
}
