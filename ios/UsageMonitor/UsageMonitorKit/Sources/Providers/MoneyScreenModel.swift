import AppCore
import DesignSystem
import Foundation
import Models
import Networking
import Observation

// ---------------------------------------------------------------------------
// The Money screen's data layer, kept deliberately separate from the view so
// the money math (what counts toward the recurring total, what reads as "not
// budgeted", how a renewal date is worded) is unit-testable without SwiftUI.
//
// Source of truth is `GET /api/subscriptions` — one bearer-readable list that
// already carries the provider reference, the monthly-equivalent cost, and the
// next renewal timestamp per row.  There is deliberately NO `/api/providers`
// call here: that route is dashboard-session-only, and everything this screen
// needs is already on the subscription payload.  Adding it would gate a
// bearer-reachable money view behind a password for no new information.
// ---------------------------------------------------------------------------

/// Owns the Money screen's single read (`GET /api/subscriptions`, bearer- or
/// dashboard-session-authorized).
///
/// Follows `Settings/HostUsageStore` exactly: the probe is injectable so tests
/// and previews never touch the network, the client is passed per call (a host
/// switch just passes the rebuilt client), and a failed *refresh* keeps the
/// previously loaded rows rather than replacing good money data with an error.
@MainActor
@Observable
final class MoneyStore {
    private(set) var state: LoadState<[SubscriptionSummary]> = .idle

    private let probe: @Sendable (APIClient) async throws -> [SubscriptionSummary]

    init(
        probe: @escaping @Sendable (APIClient) async throws -> [SubscriptionSummary] =
            MoneyStore.liveProbe
    ) {
        self.probe = probe
    }

    /// The rendered view data, recomputed from the loaded rows. `nil` until the
    /// first successful load, which is what drives skeleton vs. content.
    func viewData(now: Date = Date()) -> MoneyViewData? {
        state.value.map { MoneyViewData(subscriptions: $0, now: now) }
    }

    func loadIfNeeded(using client: APIClient) async {
        if case .idle = state { await load(using: client) }
    }

    func load(using client: APIClient) async {
        if state.value == nil { state = .loading }
        await fetch(using: client)
    }

    func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    func reset() {
        state = .idle
    }

    private func fetch(using client: APIClient) async {
        do {
            state = .loaded(try await probe(client))
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    /// A refresh failure over already-good data is never allowed to blank the
    /// screen — the operator keeps looking at the last known costs.
    private func handle(_ error: APIError) {
        if state.value == nil {
            state = .failed(error)
        }
    }

    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> [SubscriptionSummary] = {
        client in
        try await client.subscriptions()
    }
}

// ---------------------------------------------------------------------------
// Pure presentation
// ---------------------------------------------------------------------------

/// Everything the Money screen renders, derived once from the subscription
/// list plus a caller-supplied `now` (injected rather than read from the clock
/// so renewal wording is deterministic in tests).
struct MoneyViewData: Equatable {
    /// One paid service.
    struct Row: Identifiable, Equatable {
        let id: String
        let name: String
        let providerID: String
        let providerTitle: String
        let projectName: String?
        let cadence: String
        /// `true` only when the monitor actually has a recurring price on file.
        /// A row with nothing recorded must never render as "$0" — see
        /// ``monthlyLine``.
        let isBudgeted: Bool
        /// Counted toward the headline USD total (active **and** priced in USD).
        let countsTowardTotal: Bool
        let monthlyEquivalentUsd: Double
        let currency: String
        /// Trailing headline on the row: a money figure, or "Not budgeted".
        let monthlyLine: String
        /// The small line under it — cadence context or the "no cost recorded"
        /// explanation.
        let monthlySecondary: String
        /// Full price at its real cadence, e.g. "$60.00 · every 3 months".
        let priceLine: String
        /// Renewal wording, e.g. "Renews Sep 3 · in 23 days".
        let renewalLine: String
        let statusLabel: String
        let status: Theme.SemanticStatus
        /// Raw server status, kept so bucketing stays a pure function of the row.
        let effectiveStatus: String
        let renewalDate: Date?
        let billingSource: String?

        /// Provider (and project) context for the row subtitle. The provider is
        /// repeated here even though rows are grouped by provider, because
        /// VoiceOver reads rows out of their group heading.
        var subtitleLine: String {
            var parts = [providerTitle, cadence]
            if let projectName, !projectName.isEmpty { parts.append(projectName) }
            return parts.joined(separator: " · ")
        }

        var accessibilityLabel: String {
            "\(name), \(providerTitle), \(monthlyLine) \(monthlySecondary), \(renewalLine)"
        }
    }

    /// Every service belonging to one provider, plus that provider's share of
    /// the recurring total.
    struct ProviderGroup: Identifiable, Equatable {
        let providerID: String
        let providerTitle: String
        let monthlyTotalUsd: Double
        let hasBudgetedRow: Bool
        let rows: [Row]

        var id: String { providerID }

        /// The group's trailing figure. Providers whose services all lack a
        /// recorded price read as "Not budgeted", never "$0".
        var totalLine: String {
            hasBudgetedRow ? CurrencyFormat.usd(monthlyTotalUsd) : "Not budgeted"
        }

        var subtitle: String {
            rows.count == 1 ? "1 service" : "\(rows.count) services"
        }
    }

    /// Active services grouped by provider, biggest recurring cost first.
    let billingGroups: [ProviderGroup]
    /// Rows the owner is still evaluating (`considering`) — real plans, but not
    /// charging yet, so they are listed and excluded from the total.
    let considering: [Row]
    /// Paused / canceled / expired rows: shown so nothing silently disappears,
    /// never counted.
    let inactive: [Row]

    /// Sum of the monthly-equivalent cost of every active USD service.
    let monthlyTotalUsd: Double
    let activeCount: Int
    let providerCount: Int
    /// Active rows priced in a non-USD currency. Excluded from the USD total
    /// exactly as the server's budget math excludes them.
    let nonUsdActiveCount: Int
    /// Whether any active row has a recorded price at all.
    let hasBudgetedActive: Bool
    /// The soonest upcoming renewal among active rows.
    let nextRenewal: Row?

    var isEmpty: Bool {
        billingGroups.isEmpty && considering.isEmpty && inactive.isEmpty
    }

    /// The hero figure. With nothing priced there is no honest number to show,
    /// so it reads "Not budgeted" rather than a fabricated "$0.00".
    var monthlyTotalLine: String {
        hasBudgetedActive ? CurrencyFormat.usd(monthlyTotalUsd) : "Not budgeted"
    }

    /// Caption under the hero: scope first, then the USD-only caveat when it
    /// actually applies.
    var summaryLine: String {
        var parts: [String] = [
            activeCount == 1 ? "1 active service" : "\(activeCount) active services",
            providerCount == 1 ? "1 provider" : "\(providerCount) providers",
        ]
        if nonUsdActiveCount > 0 {
            parts.append("\(nonUsdActiveCount) not in USD")
        }
        return parts.joined(separator: " · ")
    }

    init(subscriptions: [SubscriptionSummary], now: Date = Date(), calendar: Calendar = .current) {
        let rows = subscriptions.map { Row(subscription: $0, now: now, calendar: calendar) }
        let byBucket = Dictionary(grouping: rows) { MoneyViewData.bucket(for: $0) }
        let activeRows = byBucket[.active] ?? []

        // Group active services by the provider carried on the payload — no
        // session-only provider lookup needed.
        var grouped: [String: [Row]] = [:]
        for row in activeRows { grouped[row.providerID, default: []].append(row) }

        billingGroups = grouped
            .map { providerID, rows in
                let ordered = rows.sorted(by: MoneyViewData.rowOrder)
                return ProviderGroup(
                    providerID: providerID,
                    providerTitle: ordered.first?.providerTitle ?? providerID,
                    monthlyTotalUsd: ordered
                        .filter(\.countsTowardTotal)
                        .reduce(0) { $0 + $1.monthlyEquivalentUsd },
                    hasBudgetedRow: ordered.contains { $0.isBudgeted && $0.countsTowardTotal },
                    rows: ordered
                )
            }
            .sorted { left, right in
                if left.monthlyTotalUsd != right.monthlyTotalUsd {
                    return left.monthlyTotalUsd > right.monthlyTotalUsd
                }
                return left.providerTitle.localizedCaseInsensitiveCompare(right.providerTitle)
                    == .orderedAscending
            }

        considering = (byBucket[.considering] ?? []).sorted(by: MoneyViewData.rowOrder)
        inactive = (byBucket[.inactive] ?? []).sorted(by: MoneyViewData.rowOrder)

        monthlyTotalUsd = activeRows
            .filter(\.countsTowardTotal)
            .reduce(0) { $0 + $1.monthlyEquivalentUsd }
        activeCount = activeRows.count
        providerCount = Set(activeRows.map(\.providerID)).count
        nonUsdActiveCount = activeRows.filter { !$0.countsTowardTotal }.count
        hasBudgetedActive = activeRows.contains { $0.isBudgeted && $0.countsTowardTotal }
        nextRenewal = activeRows
            .filter { ($0.renewalDate ?? .distantPast) >= now }
            .min { left, right in
                (left.renewalDate ?? .distantFuture) < (right.renewalDate ?? .distantFuture)
            }
    }

    // MARK: - Bucketing

    private enum Bucket: Hashable {
        case active
        case considering
        case inactive
    }

    private static func bucket(for row: Row) -> Bucket {
        switch row.effectiveStatus {
        case "active": return .active
        case "considering": return .considering
        default: return .inactive
        }
    }

    /// Most expensive first, then alphabetical — the order an owner scans when
    /// looking for what to cut.
    private static func rowOrder(_ left: Row, _ right: Row) -> Bool {
        if left.monthlyEquivalentUsd != right.monthlyEquivalentUsd {
            return left.monthlyEquivalentUsd > right.monthlyEquivalentUsd
        }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
}

// MARK: - Row derivation

extension MoneyViewData.Row {
    init(subscription: SubscriptionSummary, now: Date, calendar: Calendar) {
        let currencyCode = MoneyFormat.normalizedCurrency(subscription.currency)
        let isUsd = currencyCode == "USD"
        // The monitor stores cost as a non-optional number, so "nothing
        // recorded" arrives as a zero rather than a null. Treating that zero as
        // a real price would print "$0" for a plan whose cost is simply unknown,
        // which is worse than saying so.
        let budgeted = subscription.costUsd > 0.005 || subscription.monthlyEquivalentUsd > 0.005
        let active = subscription.effectiveStatus == "active"

        id = subscription.id
        name = subscription.name
        providerID = subscription.provider.id
        providerTitle = subscription.provider.title
        projectName = subscription.project?.name
        cadence = subscription.cadenceLabel
        isBudgeted = budgeted
        countsTowardTotal = active && isUsd
        monthlyEquivalentUsd = isUsd ? subscription.monthlyEquivalentUsd : 0
        currency = currencyCode

        if !budgeted {
            monthlyLine = "Not budgeted"
            monthlySecondary = "no recurring cost recorded"
            priceLine = "No price on file · \(subscription.cadenceLabel)"
        } else {
            monthlyLine = MoneyFormat.money(subscription.monthlyEquivalentUsd, currency: currencyCode)
            monthlySecondary = isUsd ? "per month" : "per month · not in the USD total"
            priceLine = "\(MoneyFormat.money(subscription.costUsd, currency: currencyCode)) · \(subscription.cadenceLabel)"
        }

        let date = subscription.nextRenewalDate
        renewalDate = date
        renewalLine = MoneyFormat.renewalLine(
            date: date,
            autoRenew: subscription.autoRenew,
            effectiveStatus: subscription.effectiveStatus,
            now: now,
            calendar: calendar
        )
        statusLabel = MoneyFormat.statusLabel(subscription.effectiveStatus)
        status = MoneyFormat.status(subscription.effectiveStatus)
        effectiveStatus = subscription.effectiveStatus
        billingSource = subscription.externalBillingSource.flatMap { $0.isEmpty ? nil : $0 }
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/// Money-screen wording. Separate from `CurrencyFormat` because these rules are
/// about *this* screen's honesty contract (never fabricate a figure) rather
/// than about number formatting.
enum MoneyFormat {
    static func normalizedCurrency(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return trimmed.isEmpty ? "USD" : trimmed
    }

    /// USD goes through the shared formatter so this screen renders money the
    /// same way every other surface does; other currencies keep their own code
    /// so a €-priced plan is never silently relabelled as dollars.
    static func money(_ amount: Double, currency: String) -> String {
        let code = normalizedCurrency(currency)
        if code == "USD" { return CurrencyFormat.usd(amount) }
        return amount.formatted(.currency(code: code).precision(.fractionLength(2)))
    }

    /// "Renews Sep 3 · in 23 days" / "Term ends Sep 3" / "Renewal date not
    /// reported".  Paused and canceled rows are not renewing at all, so they
    /// describe when the paid term runs out instead.
    static func renewalLine(
        date: Date?,
        autoRenew: Bool,
        effectiveStatus: String,
        now: Date,
        calendar: Calendar
    ) -> String {
        guard let date else { return "Renewal date not reported" }
        let day = date.formatted(date: .abbreviated, time: .omitted)
        let relative = relativeDayText(from: now, to: date, calendar: calendar)
        let lead: String
        switch effectiveStatus {
        case "active": lead = autoRenew ? "Renews \(day)" : "Term ends \(day)"
        case "considering": lead = "Would renew \(day)"
        default: lead = "Paid through \(day)"
        }
        return "\(lead) · \(relative)"
    }

    /// Day-granularity relative wording against an injected `now`, so tests
    /// never depend on the wall clock.
    static func relativeDayText(from now: Date, to date: Date, calendar: Calendar) -> String {
        let start = calendar.startOfDay(for: now)
        let target = calendar.startOfDay(for: date)
        guard let days = calendar.dateComponents([.day], from: start, to: target).day else {
            return "date unavailable"
        }
        switch days {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        case let ahead where ahead > 1: return "in \(ahead) days"
        default: return "\(abs(days)) days ago"
        }
    }

    /// Chip text → Title Case.
    static func statusLabel(_ effectiveStatus: String) -> String {
        switch effectiveStatus {
        case "active": return "Active"
        case "considering": return "Considering"
        case "paused": return "Paused"
        case "canceled": return "Canceled"
        case "expired": return "Expired"
        default: return effectiveStatus.capitalized
        }
    }

    static func status(_ effectiveStatus: String) -> Theme.SemanticStatus {
        switch effectiveStatus {
        case "active": return .ok
        case "considering", "paused": return .warning
        case "expired": return .danger
        default: return .neutral
        }
    }
}
