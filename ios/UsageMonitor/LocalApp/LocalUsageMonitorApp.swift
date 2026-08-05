import SwiftUI
import LocalDataPlane

/// Entry point for **Local Usage Monitor** — on-device self-host product.
@main
struct LocalUsageMonitorApp: App {
    var body: some Scene {
        WindowGroup {
            LocalRootView()
        }
    }
}
