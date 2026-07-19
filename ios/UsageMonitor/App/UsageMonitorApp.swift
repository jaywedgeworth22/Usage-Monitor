import SwiftUI
import AppCore
import Dashboard
import Providers
import Alerts
import ProjectBudgets
import Settings
import AppLock

/// The application entry point. Its entire job is composition: construct the
/// shared `AppEnvironment` (wiring the OfflineCache + widget snapshot sink),
/// supply each feature lane's root view to `AppCore`'s shell, and wrap the
/// whole thing in the AppLock gate. It owns no feature UI itself.
@main
struct UsageMonitorApp: App {
    @State private var environment: AppEnvironment

    init() {
        // The shared BudgetStore transparently persists every successful
        // response to disk (offline-first) and to the widget app group.
        _environment = State(
            initialValue: AppEnvironment(snapshotSink: OfflineCacheSnapshotSink())
        )
    }

    var body: some Scene {
        WindowGroup {
            AppLockGate {
                RootView(environment: environment, features: .live)
            }
            // AppLockGate sits outside RootView, so give it the environment too.
            .environment(environment)
        }
    }
}

private extension AppFeatures {
    /// The production wiring: each feature lane's public root view. Adding a
    /// screen never touches this beyond swapping in a richer root — the lane
    /// owns everything inside its own module.
    static let live = AppFeatures(
        dashboard: { AnyView(DashboardRootView()) },
        providers: { AnyView(ProvidersRootView()) },
        alerts: { AnyView(AlertsRootView()) },
        projects: { AnyView(ProjectBudgetsRootView()) },
        settings: { AnyView(SettingsRootView()) }
    )
}
