import SwiftUI
import AppCore
import DesignSystem
import Models

/// PLACEHOLDER — owned by the **Dashboard** lane. Replace this file's body (and
/// add sibling files in `Sources/Dashboard/`) with the real overview screen.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `DashboardRootView` with `public init()`.
///   - Read the shared `@Environment(BudgetStore.self)`; drive first load with
///     `.task { await store.loadIfNeeded() }` and pull-to-refresh with
///     `RefreshableScrollView { await store.refresh() }`.
///   - Build the summary hero, `StatTile` grid, and top-provider `BudgetMeter`s
///     from `store.summary` / `store.providers`. Map status with
///     `Theme.SemanticStatus(_:)`.
public struct DashboardRootView: View {
    @Environment(BudgetStore.self) private var store

    public init() {}

    public var body: some View {
        NavigationStack {
            Group {
                if store.providers.isEmpty {
                    EmptyState(
                        systemImage: "chart.pie.fill",
                        title: "Overview",
                        message: "The dashboard lane is under construction. Budget summary, stat tiles, and top-provider meters land here."
                    )
                } else {
                    RefreshableScrollView(onRefresh: { await store.refresh() }) {
                        Text("\(store.providers.count) providers loaded")
                            .font(Theme.Typography.body)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
            .navigationTitle(AppTab.dashboard.title)
            .task { await store.loadIfNeeded() }
        }
    }
}
