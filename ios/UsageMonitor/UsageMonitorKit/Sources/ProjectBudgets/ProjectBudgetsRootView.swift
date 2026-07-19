import SwiftUI
import AppCore
import DesignSystem
import Models

/// PLACEHOLDER — owned by the **ProjectBudgets** lane. Replace with the project
/// budget list + detail.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `ProjectBudgetsRootView` with `public init()`.
///   - Read `@Environment(BudgetStore.self)`; render `store.projects`
///     (`[ProjectBudgetStatus]`, may be empty). Use `LabeledBudgetMeter` and
///     surface `directUsd` / `allocatedUsd` / `incompleteAllocatedProviderCount`.
public struct ProjectBudgetsRootView: View {
    @Environment(BudgetStore.self) private var store

    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                systemImage: "folder.fill",
                title: "Projects",
                message: "The project budgets lane is under construction. Per-project meters and allocation detail land here."
            )
            .navigationTitle(AppTab.projects.title)
            .task { await store.loadIfNeeded() }
        }
    }
}
