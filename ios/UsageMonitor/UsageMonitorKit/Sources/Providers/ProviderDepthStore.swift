import Foundation
import Observation
import AppCore
import Models
import Networking

// ---------------------------------------------------------------------------
// Provider-detail read depth (I2).
//
// The web's money-explanation value lives in recorded history and
// provider-reported external billing — both session-gated routes
// (`GET /api/snapshots`, `GET /api/providers/:id`), unreachable by the app's
// bearer token but available whenever a dashboard session is active. This
// store loads both independently (like the web page's `Promise.allSettled`):
// a failure or missing session degrades that section only, never the
// budget-driven detail built from the shared `BudgetStore`.
// ---------------------------------------------------------------------------

@MainActor
@Observable
public final class ProviderDepthStore {
    /// Recorded usage history for the chart; `.failed(.unauthorized)` when no
    /// dashboard session is active.
    public private(set) var historyState: LoadState<[UsageSnapshotPoint]> = .idle
    /// Provider-reported external billing records.
    public private(set) var billingState: LoadState<[ExternalBillingRecord]> = .idle
    /// Set when the server rejected a depth read for lack of a session — the
    /// view surfaces a sign-in hint instead of an error.
    public private(set) var requiresSession = false

    private var loadedProviderID: String?

    public init() {}

    public func loadIfNeeded(providerID: String, using client: APIClient) async {
        guard loadedProviderID != providerID else { return }
        loadedProviderID = providerID
        await load(providerID: providerID, using: client)
    }

    public func refresh(providerID: String, using client: APIClient) async {
        await load(providerID: providerID, using: client)
    }

    /// Chronological reported-spend series for the history chart, or `nil`
    /// when there aren't enough recorded points to draw one.
    public var spendHistoryPoints: [Double]? {
        guard let snapshots = historyState.value else { return nil }
        return ProviderHistorySeries.spendPoints(from: snapshots)
    }

    /// Latest recorded spend figure (the chart's headline value).
    public var latestRecordedSpend: Double? {
        guard let snapshots = historyState.value else { return nil }
        return ProviderHistorySeries.latestSpend(from: snapshots)
    }

    public var snapshotPointCount: Int {
        historyState.value?.count ?? 0
    }

    public var billingRecords: [ExternalBillingRecord] {
        billingState.value ?? []
    }

    private func load(providerID: String, using client: APIClient) async {
        if historyState.value == nil { historyState = .loading }
        if billingState.value == nil { billingState = .loading }

        do {
            let snapshots = try await client.usageSnapshots(providerID: providerID)
            historyState = .loaded(snapshots)
        } catch is CancellationError {
            return
        } catch let error as APIError {
            if error == .unauthorized { requiresSession = true }
            // Keep stale points on a refresh failure; fail the state only when
            // there is nothing to show.
            if historyState.value == nil { historyState = .failed(error) }
        } catch {
            if historyState.value == nil {
                historyState = .failed(.transport(error.localizedDescription))
            }
        }

        do {
            let detail = try await client.providerDetail(id: providerID)
            billingState = .loaded(detail.externalBilling ?? [])
        } catch is CancellationError {
            return
        } catch let error as APIError {
            if error == .unauthorized { requiresSession = true }
            if billingState.value == nil { billingState = .failed(error) }
        } catch {
            if billingState.value == nil {
                billingState = .failed(.transport(error.localizedDescription))
            }
        }
    }
}

/// Pure, testable series math for the recorded-history chart.
public enum ProviderHistorySeries {
    /// Cap on rendered points so a dense raw window stays readable (and cheap)
    /// in the hand-drawn sparkline.
    public static let maxRenderedPoints = 90

    /// Chronological reported-spend (`totalCost`) series from snapshot
    /// history. Points without a reported cost are skipped; raw and
    /// server-synthesized rollup rows interleave correctly because both carry
    /// real `fetchedAt` timestamps. Returns `nil` when fewer than two cost
    /// points exist — the caller then keeps the labeled estimated-pace
    /// fallback instead of drawing a degenerate chart.
    public static func spendPoints(from snapshots: [UsageSnapshotPoint]) -> [Double]? {
        let sorted = snapshots
            .filter { $0.totalCost != nil }
            .sorted { $0.fetchedAt < $1.fetchedAt }
        guard sorted.count >= 2 else { return nil }
        let points = sorted.compactMap(\.totalCost)
        guard points.count > maxRenderedPoints else { return points }
        // Evenly sample down to the cap, always keeping first and last.
        let strideLength = Double(points.count - 1) / Double(maxRenderedPoints - 1)
        return (0..<maxRenderedPoints).map { index in
            points[Int((Double(index) * strideLength).rounded())]
        }
    }

    /// The most recent reported spend figure, if any.
    public static func latestSpend(from snapshots: [UsageSnapshotPoint]) -> Double? {
        snapshots
            .filter { $0.totalCost != nil }
            .sorted { $0.fetchedAt < $1.fetchedAt }
            .last?
            .totalCost
    }
}
