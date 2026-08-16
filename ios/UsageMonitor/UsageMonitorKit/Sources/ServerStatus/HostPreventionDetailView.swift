import SwiftUI
import DesignSystem
import Models

/// Full host prevention panel: all risk indicators + recent poll history.
/// Aimed at catching OOM-adjacent CPU pegs, disk fill, app downs, and backup lag.
struct HostPreventionDetailView: View {
    let prevention: ServerMetrics.Prevention

    var body: some View {
        List {
            Section {
                LabeledContent("Overall") {
                    StatusBadge(
                        overallLabel,
                        status: overallStatus,
                        systemImage: prevention.overall == "ok"
                            ? "checkmark.shield.fill"
                            : "exclamationmark.shield.fill"
                    )
                }
                if let note = prevention.historyNote {
                    Text(note)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            } footer: {
                Text("Indicators fire before the next outage when possible.  History is process-local and clears on container restart.")
            }

            if let summary = prevention.summary {
                Section("Stats") {
                    if let peak = summary.cpuPeakPct {
                        LabeledContent("CPU Peak (1h)", value: String(format: "%.0f%%", peak))
                    }
                    if let avg = summary.cpuAvgPct {
                        LabeledContent("CPU Avg (1h)", value: String(format: "%.0f%%", avg))
                    }
                    if let latest = summary.cpuLatestPct {
                        LabeledContent("CPU Latest", value: String(format: "%.0f%%", latest))
                    }
                    if let used = summary.diskUsedPct {
                        LabeledContent("Disk Used", value: "\(used)%")
                    }
                    if let free = summary.diskFreeBytes {
                        LabeledContent("Disk Free", value: DiskFormat.byteString(free))
                    }
                    if let healthy = summary.appsHealthy, let total = summary.appsTotal {
                        LabeledContent(
                            "Apps Healthy",
                            value: "\(healthy)/\(total)"
                        )
                    }
                    if let down = summary.appsDown, down > 0 {
                        LabeledContent("Apps Down", value: "\(down)")
                    }
                    if let ok = summary.backupAppsOk, let total = summary.backupAppsTotal {
                        LabeledContent("Backup Apps OK", value: "\(ok)/\(total)")
                    }
                }
            }

            if !prevention.indicators.isEmpty {
                Section("Active Indicators") {
                    ForEach(prevention.indicators) { indicator in
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            HStack {
                                Text(indicator.label)
                                    .font(Theme.Typography.captionEmphasis)
                                if let subject = indicator.subject {
                                    Text(subject)
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                                Spacer()
                                StatusBadge(
                                    indicator.severity.capitalized,
                                    status: severityStatus(indicator.severity),
                                    systemImage: indicator.severity == "critical"
                                        ? "xmark.octagon.fill"
                                        : "exclamationmark.triangle.fill"
                                )
                            }
                            Text(indicator.detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }

            if !prevention.history.isEmpty {
                Section("Recent Poll History") {
                    // Simple sparkline-ish text trail (newest last)
                    if let cpuTrail = cpuHistoryTrail {
                        LabeledContent("CPU Trail", value: cpuTrail)
                    }
                    ForEach(prevention.history.suffix(12).reversed()) { sample in
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            HStack {
                                Text(sample.at)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                Spacer()
                                StatusBadge(
                                    sample.overall?.capitalized ?? "—",
                                    status: overallSampleStatus(sample.overall),
                                    systemImage: "circle.fill"
                                )
                            }
                            Text(historyLine(sample))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    }
                }
            }
        }
        .navigationTitle("Host Stats")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var overallLabel: String {
        switch prevention.overall {
        case "critical": return "Critical"
        case "warning": return "Watch"
        default: return "OK"
        }
    }

    private var overallStatus: Theme.SemanticStatus {
        switch prevention.overall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private var cpuHistoryTrail: String? {
        let values = prevention.history.compactMap(\.cpuPct)
        guard values.count >= 2 else { return nil }
        return values.suffix(12).map { String(format: "%.0f", $0) }.joined(separator: " → ") + "%"
    }

    private func historyLine(_ sample: ServerMetrics.Prevention.HistorySample) -> String {
        var parts: [String] = []
        if let cpu = sample.cpuPct {
            parts.append(String(format: "CPU %.0f%%", cpu))
        }
        if let disk = sample.diskUsedPct {
            parts.append("disk \(disk)%")
        }
        if let down = sample.appsDown, down > 0 {
            parts.append("\(down) app down")
        }
        if let ids = sample.indicatorIds, !ids.isEmpty {
            parts.append("\(ids.count) flag\(ids.count == 1 ? "" : "s")")
        }
        return parts.isEmpty ? "No samples" : parts.joined(separator: " · ")
    }

    private func severityStatus(_ severity: String) -> Theme.SemanticStatus {
        switch severity {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private func overallSampleStatus(_ overall: String?) -> Theme.SemanticStatus {
        switch overall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }
}
