import WidgetKit
import SwiftUI
import AppIntents
import WidgetShared
import DesignSystem

/// The widget extension entry point. Owned jointly by the **WidgetShared** lane
/// (the data bridge, already built) and the **Widget UI** lane (these views).
///
/// The extension is deliberately model- and networking-free: it renders the
/// compact `WidgetSnapshot` the app persists to the shared app-group container
/// after every successful refresh, so the home-screen widget shows real,
/// recently-cached data even when the host app isn't running. When no snapshot
/// has been written yet (fresh install, signed-out) it falls back to zeros via
/// `.empty` (gallery previews use `.placeholder`).
///
/// Users long-press → Edit Widget to pick **Overall** or a **project budget**.
@main
struct UsageMonitorWidgetBundle: WidgetBundle {
    var body: some Widget {
        BudgetSummaryWidget()
    }
}

// MARK: - Timeline

struct BudgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
    let content: WidgetBudgetContent
}

struct BudgetTimelineProvider: AppIntentTimelineProvider {
    typealias Intent = SelectBudgetIntent

    func placeholder(in context: Context) -> BudgetEntry {
        entry(snapshot: .placeholder, focus: .overall)
    }

    func snapshot(for configuration: SelectBudgetIntent, in context: Context) async -> BudgetEntry {
        let snapshot = context.isPreview
            ? WidgetSnapshot.placeholder
            : (SharedStore.shared.read() ?? .empty)
        return entry(snapshot: snapshot, focus: configuration.focus)
    }

    func timeline(for configuration: SelectBudgetIntent, in context: Context) async -> Timeline<BudgetEntry> {
        let snapshot = SharedStore.shared.read() ?? .empty
        let item = entry(snapshot: snapshot, focus: configuration.focus)
        // The app refreshes the snapshot on foreground / background fetch; the
        // widget just re-reads periodically. 30 min is a battery-safe cadence
        // that still keeps spend reasonably fresh through the day.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
            ?? Date().addingTimeInterval(1800)
        return Timeline(entries: [item], policy: .after(next))
    }

    private func entry(snapshot: WidgetSnapshot, focus: WidgetBudgetFocus) -> BudgetEntry {
        BudgetEntry(
            date: Date(),
            snapshot: snapshot,
            content: WidgetPresentation.content(from: snapshot, focus: focus)
        )
    }
}

// MARK: - Widget

struct BudgetSummaryWidget: Widget {
    let kind = "BudgetSummaryWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: SelectBudgetIntent.self,
            provider: BudgetTimelineProvider()
        ) { entry in
            BudgetWidgetView(entry: entry)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(entry.content.deepLink)
        }
        .configurationDisplayName("Budget")
        .description("Overall account spend or a project budget. Edit to choose.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Root view (family switch)

struct BudgetWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BudgetEntry

    var body: some View {
        switch family {
        case .systemMedium:
            MediumBudgetWidget(entry: entry)
        default:
            SmallBudgetWidget(entry: entry)
        }
    }
}

// MARK: - Shared summary column

/// The month-to-date hero: focus title, big total, "of budget", overall meter, and
/// (only when off-track) a status badge. Reused by both families.
private struct BudgetSummaryColumn: View {
    let entry: BudgetEntry
    var showsBadge = true
    var showsUpdatedAt = true

    private var content: WidgetBudgetContent { entry.content }
    private var snapshot: WidgetSnapshot { entry.snapshot }
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }
    private var stale: Bool { WidgetPresentation.isStale(for: snapshot) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(content.title)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                if stale {
                    Text("STALE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.Colors.warning)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(
                            Theme.Colors.warning.opacity(0.15),
                            in: Capsule()
                        )
                        .accessibilityLabel("Data is stale")
                }
            }

            Text(WidgetPresentation.displayAmount(content.spentUsd, redacted: redacted))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .privacySensitive(redacted)

            if !redacted, let caption = WidgetPresentation.budgetCaption(for: content) {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }

            if content.budgetUsd > 0, !redacted {
                BudgetMeter(
                    fraction: WidgetPresentation.fraction(
                        spent: content.spentUsd,
                        budget: content.budgetUsd
                    ),
                    status: WidgetPresentation.status(for: content),
                    height: 8
                )
                .padding(.top, Theme.Spacing.xxs)
            }

            if showsBadge, let label = WidgetPresentation.label(for: content) {
                StatusBadge(
                    label,
                    status: WidgetPresentation.status(for: content),
                    systemImage: WidgetPresentation.symbol(for: content)
                )
                .padding(.top, Theme.Spacing.xxs)
            }

            if showsUpdatedAt, let caption = WidgetPresentation.updatedCaption(for: snapshot) {
                HStack(spacing: Theme.Spacing.xxs) {
                    Image(systemName: stale ? "clock.badge.exclamationmark" : "clock")
                    Text(caption)
                }
                .font(Theme.Typography.caption)
                .foregroundStyle(stale ? Theme.Colors.warning : Theme.Colors.tertiaryText)
                .padding(.top, Theme.Spacing.xxs)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(caption)
            }
        }
    }
}

// MARK: - Small

private struct SmallBudgetWidget: View {
    let entry: BudgetEntry

    private var content: WidgetBudgetContent { entry.content }
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BudgetSummaryColumn(entry: entry)
            Spacer(minLength: 0)
            if content.projectedEomUsd > 0 {
                Text("Proj. \(WidgetPresentation.displayAmount(content.projectedEomUsd, redacted: redacted))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .privacySensitive(redacted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Medium

private struct MediumBudgetWidget: View {
    let entry: BudgetEntry

    private var content: WidgetBudgetContent { entry.content }
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    private var meters: [WidgetSnapshot.Meter] {
        content.meters
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            BudgetSummaryColumn(entry: entry)
                .frame(maxWidth: .infinity, alignment: .leading)

            if content.focus != .overall {
                projectSidePanel
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if meters.isEmpty {
                emptyMeters
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(meters) { meter in
                        LabeledBudgetMeter(
                            title: meter.name,
                            detail: WidgetPresentation.displayMeterDetail(
                                spent: meter.spentUsd,
                                budget: meter.budgetUsd,
                                redacted: redacted
                            ),
                            fraction: redacted
                                ? 0
                                : WidgetPresentation.fraction(
                                    spent: meter.spentUsd,
                                    budget: meter.budgetUsd
                                ),
                            status: WidgetPresentation.semanticStatus(forRawStatus: meter.status)
                        )
                        .privacySensitive(redacted)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var projectSidePanel: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Image(systemName: "folder.fill")
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text("Project budget")
                .font(Theme.Typography.callout.weight(.medium))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Edit Widget to switch to Overall or another project.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }

    private var emptyMeters: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text("No budgets set")
                .font(Theme.Typography.callout.weight(.medium))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Configure provider budgets to track them here.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

// MARK: - Previews

#Preview("Small · Overall", as: .systemSmall) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetPresentation.content(from: .placeholder, focus: .overall)
    )
}

#Preview("Medium · Overall", as: .systemMedium) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetPresentation.content(from: .placeholder, focus: .overall)
    )
}

#Preview("Medium · Project", as: .systemMedium) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetPresentation.content(from: .placeholder, focus: .project(id: "proj-ct"))
    )
}
