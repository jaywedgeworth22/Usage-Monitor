import Foundation
import Observation
import AppCore
import Models
import Networking

/// Owns the Overview **Chart range** load: session-gated
/// `GET /api/usage-events` filtered by `TimeframeOption`.
///
/// Month-to-date budget figures never use this store — only the portfolio
/// history card below the hero.
@MainActor
@Observable
public final class PortfolioHistoryStore {
    /// Default chart range for a cold launch.  Owner preference 2026-09-04:
    /// "Past 30 days" is the new web + iOS default; "This month" is preserved
    /// for budget math (which this store does NOT touch).
    public static let defaultTimeframe: TimeframeOption = .rolling(days: 30)

    public private(set) var state: LoadState<UsageEventsSummary> = .idle
    public private(set) var timeframe: TimeframeOption = PortfolioHistoryStore.defaultTimeframe
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    public private(set) var isReloading = false

    public init() {}

    public var summary: UsageEventsSummary? { state.value }

    public func reset() {
        state = .idle
        timeframe = PortfolioHistoryStore.defaultTimeframe
        requiresSession = false
        lastError = nil
        isReloading = false
    }

    public func loadIfNeeded(using client: APIClient) async {
        if case .idle = state {
            await refresh(using: client)
        }
    }

    public func refresh(using client: APIClient) async {
        await fetch(using: client, isRangeChange: false)
    }

    public func selectTimeframe(_ option: TimeframeOption, using client: APIClient?) async {
        guard option != timeframe else { return }
        timeframe = option
        guard let client else { return }
        await fetch(using: client, isRangeChange: true)
    }

    private func fetch(using client: APIClient, isRangeChange: Bool) async {
        // Range changes (and the first load) KEEP the prior summary on screen
        // so the user always sees what they were just looking at, dimmed with
        // a small spinner, instead of a blank skeleton.  Owner 2026-09-04:
        // "change the time period seems to do nothing" — the skeleton was
        // making the change feel like no progress was happening.
        let previous = state.value
        if previous != nil {
            isReloading = true
        } else {
            state = .loading
        }
        defer { isReloading = false }

        do {
            let summary = try await client.usageEventsSummary(
                queryItems: timeframe.usageEventsQueryItems
            )
            state = .loaded(summary)
            requiresSession = false
            lastError = nil
        } catch let error as APIError {
            if case .unauthorized = error {
                requiresSession = true
                state = .idle
                lastError = nil
                return
            }
            if let previous {
                state = .loaded(previous)
                lastError = error
            } else {
                state = .failed(error)
            }
        } catch {
            let transport = APIError.transport(error.localizedDescription)
            if let previous {
                state = .loaded(previous)
                lastError = transport
            } else {
                state = .failed(transport)
            }
        }
    }
}
