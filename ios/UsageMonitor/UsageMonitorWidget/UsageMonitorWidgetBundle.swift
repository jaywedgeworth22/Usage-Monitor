import WidgetKit
import SwiftUI
import WidgetShared
import DesignSystem

/// The widget extension entry point. Owned jointly by the **WidgetShared** lane
/// (data bridge, already built) and the widget UI (expand the views below).
/// This starter renders real cached data from the app group via `SharedStore`.
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
}

struct BudgetTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> BudgetEntry {
        BudgetEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (BudgetEntry) -> Void) {
        completion(BudgetEntry(date: Date(), snapshot: SharedStore.shared.read() ?? .placeholder))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BudgetEntry>) -> Void) {
        let snapshot = SharedStore.shared.read() ?? .placeholder
        let entry = BudgetEntry(date: Date(), snapshot: snapshot)
        // Refresh cadence is a lane decision; every 30 min is a safe default.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Widget

struct BudgetSummaryWidget: Widget {
    let kind = "BudgetSummaryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BudgetTimelineProvider()) { entry in
            BudgetWidgetView(snapshot: entry.snapshot)
                .containerBackground(Theme.Colors.background, for: .widget)
        }
        .configurationDisplayName("Budget")
        .description("Month-to-date spend across your providers.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct BudgetWidgetView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("This month")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            Text(CurrencyFormat.compactUSD(snapshot.totalSpentUsd))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
            if snapshot.totalBudgetUsd > 0 {
                Text("of \(CurrencyFormat.compactUSD(snapshot.totalBudgetUsd))")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
