import SwiftUI
import AppCore
import DesignSystem
import Models

/// PLACEHOLDER — owned by the **Alerts** lane. Replace with the aggregated
/// alerts feed.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `AlertsRootView` with `public init()`.
///   - Read `@Environment(BudgetStore.self)`; render `store.alertItems`
///     (already flattened + severity-sorted). Use each `ProviderAlert`'s
///     `title`/`symbolName` and map `alert.severity` via
///     `Theme.SemanticStatus(_:)`.
public struct AlertsRootView: View {
    @Environment(BudgetStore.self) private var store

    public init() {}

    public var body: some View {
        NavigationStack {
            Group {
                if store.alertItems.isEmpty {
                    EmptyState(
                        systemImage: "checkmark.circle.fill",
                        title: "All clear",
                        message: "No active alerts. The alerts lane is under construction — grouped, severity-sorted alerts land here."
                    )
                } else {
                    List(store.alertItems) { item in
                        StatusBadge(
                            item.alert.title,
                            status: .init(item.alert.severity),
                            systemImage: item.alert.symbolName
                        )
                    }
                }
            }
            .navigationTitle(AppTab.alerts.title)
            .task { await store.loadIfNeeded() }
        }
    }
}
