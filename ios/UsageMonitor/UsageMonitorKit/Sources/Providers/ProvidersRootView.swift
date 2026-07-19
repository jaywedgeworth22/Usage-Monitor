import SwiftUI
import AppCore
import DesignSystem
import Models

/// PLACEHOLDER — owned by the **Providers** lane. Replace with the provider
/// list + provider budget detail.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `ProvidersRootView` with `public init()`.
///   - Read `@Environment(BudgetStore.self)`; list `store.providers` with
///     `ProviderRow`, push a detail from `ProviderBudgetStatus` (all fields are
///     already present in the shared response — no per-provider fetch needed;
///     `GET /api/providers/{id}` is session-gated and NOT reachable by token).
public struct ProvidersRootView: View {
    @Environment(BudgetStore.self) private var store

    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                systemImage: "square.stack.3d.up.fill",
                title: "Providers",
                message: "The providers lane is under construction. A searchable list and per-provider budget detail land here."
            )
            .navigationTitle(AppTab.providers.title)
            .task { await store.loadIfNeeded() }
        }
    }
}
