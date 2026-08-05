import SwiftUI
import LocalDataPlane

/// Entry point for **Usage Monitor Local** — on-device self-host product.
@main
struct UsageMonitorLocalApp: App {
    var body: some Scene {
        WindowGroup {
            LocalRootView()
        }
    }
}
