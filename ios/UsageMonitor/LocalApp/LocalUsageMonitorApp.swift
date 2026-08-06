import SwiftUI
import LocalDataPlane
import AppCore
import AppLock

/// Entry point for **Local Usage Monitor** — on-device self-host product.
/// App Lock + appearance without a remote API client (phone is the instance).
@main
struct LocalUsageMonitorApp: App {
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            LocalAppLockGate(settings: settings) {
                LocalRootView(settings: settings)
            }
            .preferredColorScheme(settings.theme.colorScheme)
        }
    }
}
