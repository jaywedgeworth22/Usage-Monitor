import Foundation
import AppCore
import Models
import Networking

/// Launch-argument helpers for App Store screenshot capture.
/// Pass `-ScreenshotDemo` to the app (and optionally `-ScreenshotTab dashboard`).
enum ScreenshotDemo {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("-ScreenshotDemo")
    }

    /// Optional tab raw value (`dashboard`, `providers`, `alerts`, `projects`, `settings`).
    static var preferredTab: AppTab? {
        let args = ProcessInfo.processInfo.arguments
        guard let idx = args.firstIndex(of: "-ScreenshotTab"), args.indices.contains(idx + 1) else {
            return nil
        }
        return AppTab(rawValue: args[idx + 1])
    }
}

/// Offline-first sink that always paints fixture budget data for screenshots.
struct ScreenshotDemoSnapshotSink: BudgetSnapshotSink {
    func store(_ response: BudgetStatusResponse) async {}
    func loadCached() async -> CachedBudgetSnapshot? {
        CachedBudgetSnapshot(response: .sample, cachedAt: Date())
    }
    func clear() async {}
}
