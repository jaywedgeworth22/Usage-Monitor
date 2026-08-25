import Foundation
import Models
import WidgetShared

#if canImport(WidgetKit)
import WidgetKit
#endif

/// Merge-writes compact widget sections into the shared app-group snapshot.
/// Budget, LLM, and server refreshes each update only their own fields so a
/// successful budget poll cannot wipe a later LLM or host cache.
public enum WidgetSnapshotStore {
    private static var lastWidgetReload = Date.distantPast
    private static let minimumWidgetReloadInterval: TimeInterval = 60
    private static let reloadLock = NSLock()

    public static func updateBudget(_ response: BudgetStatusResponse, maxMeters: Int = 3) {
        let budget = WidgetSnapshotBuilder.snapshot(from: response, maxMeters: maxMeters)
        SharedStore.shared.update { current in
            current = budget.mergingPreservedSections(from: current)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateLlm(_ response: LlmBurnResponse, now: Date = Date()) {
        guard let section = WidgetSnapshotBuilder.llmSection(from: response, now: now) else { return }
        SharedStore.shared.update { current in
            current = current.replacingLlm(section)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateServerService(
        health: ServerHealth,
        readiness: ServerReadiness?,
        now: Date = Date()
    ) {
        let service = WidgetSnapshotBuilder.serverService(health: health, readiness: readiness, now: now)
        SharedStore.shared.update { current in
            current = current.replacingServerService(service)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateServerHost(_ metrics: ServerMetrics, now: Date = Date()) {
        let projected = WidgetSnapshotBuilder.serverHost(from: metrics, now: now)
        SharedStore.shared.update { current in
            current = current.replacingServerHost(projected.host, apps: projected.apps)
        }
        reloadWidgetsIfNeeded()
    }

    public static func reloadWidgetsIfNeeded(force: Bool = false, now: Date = Date()) {
        reloadLock.lock()
        defer { reloadLock.unlock() }
        guard force || now.timeIntervalSince(lastWidgetReload) >= minimumWidgetReloadInterval else {
            return
        }
        lastWidgetReload = now
        #if canImport(WidgetKit) && os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }
}
