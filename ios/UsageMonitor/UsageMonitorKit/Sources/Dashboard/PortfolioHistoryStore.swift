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
    /// The timeframe that `state`'s currently-visible summary actually belongs
    /// to.  Kept distinct from `timeframe` (which flips the instant a chip is
    /// tapped, so the chip row highlights immediately) so the caption never
    /// claims numbers for a range that hasn't loaded yet — see
    /// `summaryTimeframe` usage in `PortfolioHistorySection`.
    public private(set) var summaryTimeframe: TimeframeOption = PortfolioHistoryStore.defaultTimeframe
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    public private(set) var isReloading = false

    public init() {}

    public var summary: UsageEventsSummary? { state.value }

    public func reset() {
        state = .idle
        timeframe = PortfolioHistoryStore.defaultTimeframe
        summaryTimeframe = PortfolioHistoryStore.defaultTimeframe
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
        await fetch(using: client)
    }

    public func selectTimeframe(_ option: TimeframeOption, using client: APIClient?) async {
        guard option != timeframe else { return }
        timeframe = option
        guard let client else { return }
        await fetch(using: client)
    }

    private func fetch(using client: APIClient) async {
        // Range changes (and the first load) KEEP the prior summary on screen
        // so the user always sees what they were just looking at, dimmed with
        // a small spinner, instead of a blank skeleton.  Owner 2026-09-04:
        // "change the time period seems to do nothing" — the skeleton was
        // making the change feel like no progress was happening.
        //
        // `timeframe` may already point at the NEW range by the time this
        // runs (selectTimeframe flips it synchronously so the chip highlights
        // right away), so capture the range this particular fetch is actually
        // for and only stamp it onto `summaryTimeframe` once its data lands.
        // Otherwise the caption would show the new range's label next to the
        // old range's numbers until the fetch completes.
        let requestedTimeframe = timeframe
        let previous = state.value
        if previous != nil {
            isReloading = true
        } else {
            state = .loading
        }
        defer { isReloading = false }

        do {
            let summary = try await client.usageEventsSummary(
                queryItems: requestedTimeframe.usageEventsQueryItems
            )
            state = .loaded(summary)
            summaryTimeframe = requestedTimeframe
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
                // Still showing `previous`, which belongs to the range already
                // recorded in `summaryTimeframe` — leave it untouched so the
                // caption keeps matching what's on screen.
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
