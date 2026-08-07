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
    public private(set) var state: LoadState<UsageEventsSummary> = .idle
    public private(set) var timeframe: TimeframeOption = .currentMonth
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    public private(set) var isReloading = false

    public init() {}

    public var summary: UsageEventsSummary? { state.value }

    public func reset() {
        state = .idle
        timeframe = .currentMonth
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
        let previous = state.value
        if previous != nil && isRangeChange {
            isReloading = true
            // Clear so the total/caption cannot look stuck on the prior window.
            state = .loading
        } else if state.value == nil {
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
