import SwiftUI
import DesignSystem
import Models
import AppCore

/// Overview chart-range card: timeframe control drives usage-events summary.
/// Explicitly labeled so MTD budgets are never confused with history.
struct PortfolioHistorySection: View {
    @Bindable var store: PortfolioHistoryStore
    var onOpenSettings: (() -> Void)?
    var onSelectTimeframe: (TimeframeOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Chart Range",
                subtitle: "Usage history only · budgets stay month-to-date"
            )

            // Primary chips (web parity): This month / 7d / 30d / 90d + More menu.
            ChartRangeControl(
                selection: store.timeframe,
                isBusy: store.isReloading || store.state.isInitialLoading,
                onSelect: onSelectTimeframe
            )

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    @ViewBuilder
    private var content: some View {
        if store.requiresSession {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Full Access Required for History")
                    .font(Theme.Typography.callout.weight(.semibold))
                Text("Sign in with the dashboard password in Settings to load usage history for the selected range.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                if let onOpenSettings {
                    Button("Open Settings", action: onOpenSettings)
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.Colors.accent)
                }
            }
        } else if store.state.isInitialLoading {
            // Only the first cold load gets a skeleton; reloads keep the prior
            // summary on screen (dimmed + spinner) so the user never sees a
            // blank card just because they picked a new range.
            SkeletonBlock(height: 72, radius: Theme.Radius.md)
                .accessibilityLabel("Loading usage history for \(store.timeframe.displayLabel)")
        } else if let error = store.state.error {
            Text(error.message)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.warning)
        } else if let summary = store.summary {
            summaryBody(summary)
        } else {
            Text("Pull to refresh after signing in for full access.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func summaryBody(_ summary: UsageEventsSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(CurrencyFormat.usd(summary.totalCostUsd))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .opacity(store.isReloading ? 0.55 : 1)
                Spacer()
                if store.isReloading {
                    ProgressView().controlSize(.small)
                }
            }
            Text("\(store.timeframe.displayLabel) · \(summary.groupCount) group\(summary.groupCount == 1 ? "" : "s")")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)

            ForEach(summary.topGroups(limit: 4)) { group in
                HStack {
                    Text(group.title)
                        .font(Theme.Typography.caption)
                        .lineLimit(1)
                    if let project = group.projectName, !project.isEmpty {
                        Text("· \(project)")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(CurrencyFormat.usd(group.totalCostUsd))
                        .font(Theme.Typography.captionEmphasis)
                        .monospacedDigit()
                }
            }

            if let err = store.lastError {
                Text("Couldn't refresh — \(err.title). Showing last loaded range.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Usage history \(store.timeframe.displayLabel), \(CurrencyFormat.usd(summary.totalCostUsd))"
        )
    }
}

/// Compact chart-range control: This month / 30d / 90d / 180d / 12m + More (menu).
public struct ChartRangeControl: View {
    public let selection: TimeframeOption
    public var isBusy: Bool = false
    public let onSelect: (TimeframeOption) -> Void

    public init(
        selection: TimeframeOption,
        isBusy: Bool = false,
        onSelect: @escaping (TimeframeOption) -> Void
    ) {
        self.selection = selection
        self.isBusy = isBusy
        self.onSelect = onSelect
    }

    private let primary: [(label: String, option: TimeframeOption)] = [
        ("This month", .currentMonth),
        ("30d", .rolling(days: 30)),
        ("90d", .rolling(days: 90)),
        ("180d", .rolling(days: 180)),
        ("12m", .rolling(days: 365)),
    ]

    private var moreOptions: [TimeframeOption] {
        [
            .rolling(days: 1),
            .rolling(days: 7),
            .rolling(days: 30),
            .rolling(days: 90),
            .rolling(days: 180),
            .rolling(days: 365),
            .rolling(days: 3650),
        ]
            + TimeframeOption.recentMonths(count: 13).filter { $0 != .currentMonth }
            + TimeframeOption.recentYears(count: 3)
    }

    private var primaryContainsSelection: Bool {
        primary.contains { $0.option == selection }
    }

    public var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.xs) {
                    ForEach(primary, id: \.option) { item in
                        chip(label: item.label, selected: selection == item.option) {
                            Haptics.selection()
                            onSelect(item.option)
                        }
                    }
                    Menu {
                        Section("Rolling") {
                            ForEach([
                                TimeframeOption.rolling(days: 1),
                                .rolling(days: 7),
                                .rolling(days: 30),
                                .rolling(days: 90),
                                .rolling(days: 180),
                                .rolling(days: 365),
                                .rolling(days: 3650),
                            ], id: \.self) { option in
                                Button {
                                    Haptics.selection()
                                    onSelect(option)
                                } label: {
                                    if selection == option {
                                        Label(option.displayLabel, systemImage: "checkmark")
                                    } else {
                                        Text(option.displayLabel)
                                    }
                                }
                            }
                        }

                        Section("Calendar Months") {
                            ForEach(TimeframeOption.recentMonths(count: 13), id: \.self) { option in
                                Button {
                                    Haptics.selection()
                                    onSelect(option)
                                } label: {
                                    if selection == option {
                                        Label(
                                            option == .currentMonth ? "\(option.displayLabel) (this month)" : option.displayLabel,
                                            systemImage: "checkmark"
                                        )
                                    } else {
                                        Text(option == .currentMonth ? "\(option.displayLabel) (this month)" : option.displayLabel)
                                    }
                                }
                            }
                        }

                        Section("Calendar Years") {
                            ForEach(TimeframeOption.recentYears(count: 3), id: \.self) { option in
                                Button {
                                    Haptics.selection()
                                    onSelect(option)
                                } label: {
                                    if selection == option {
                                        Label(option.displayLabel, systemImage: "checkmark")
                                    } else {
                                        Text(option.displayLabel)
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(primaryContainsSelection ? "More" : shortMoreLabel)
                                .font(Theme.Typography.caption.weight(.semibold))
                            Image(systemName: "chevron.down")
                                .font(.caption2.weight(.semibold))
                        }
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Spacing.xs)
                        .background(
                            primaryContainsSelection
                                ? Theme.Colors.fill
                                : Theme.Colors.accentSoft,
                            in: Capsule()
                        )
                        .foregroundStyle(
                            primaryContainsSelection
                                ? Theme.Colors.primaryText
                                : Theme.Colors.accent
                        )
                    }
                    .disabled(isBusy)
                    .accessibilityLabel("More chart ranges")
                    .accessibilityValue(primaryContainsSelection ? "More" : selection.displayLabel)
                }
            }
            .disabled(isBusy)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Chart range")
            .accessibilityValue(selection.displayLabel)
            .accessibilityHint("Changes usage history only. Budgets stay month-to-date.")
            // Spinner to the right of the chips so the user sees progress
            // while a new range is loading (was previously invisible: the
            // whole card just blanked for several seconds — owner 2026-09-04).
            if isBusy {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading \(selection.displayLabel)")
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isBusy)
    }

    private var shortMoreLabel: String {
        switch selection {
        case .rolling(let d) where d == 1: return "24h"
        case .rolling(let d) where d == 7: return "7d"
        case .rolling(let d) where d == 30: return "30d"
        case .rolling(let d) where d == 90: return "90d"
        case .rolling(let d) where d == 180: return "180d"
        case .rolling(let d) where d == 365: return "12m"
        case .rolling: return "All"
        case .calendarMonth, .calendarYear: return selection.displayLabel
        }
    }

    private func chip(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Typography.caption.weight(.semibold))
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xs)
                .background(
                    selected ? Theme.Colors.accent : Theme.Colors.fill,
                    in: Capsule()
                )
                .foregroundStyle(selected ? Color.white : Theme.Colors.primaryText)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
