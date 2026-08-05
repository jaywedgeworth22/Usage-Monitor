import SwiftUI
import LocalDataPlane
import LocalStore

/// Entry point for **Usage Monitor Local** — the on-device self-host product.
///
/// Composition only. Does **not** construct remote `APIClient` / `BudgetStore`
/// / session cookies. Face ID `AppLockGate` requires remote `AppEnvironment`
/// today — re-enable once Local ships its own settings (Milestone A Settings).
/// Milestone A wires LocalStore → adapters → BudgetEngine under this shell.
@main
struct UsageMonitorLocalApp: App {
    @State private var store = PlaceholderLocalStore.shared

    var body: some Scene {
        WindowGroup {
            LocalRootView(store: store)
        }
    }
}
