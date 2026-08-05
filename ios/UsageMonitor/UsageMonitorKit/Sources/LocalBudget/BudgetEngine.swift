import Foundation
import LocalStore

/// BudgetEngine v1 — design §2.3 (locked golden vectors).
public enum BudgetEngine {
    public struct ProviderSpend: Equatable, Sendable {
        public var providerId: String
        public var displayName: String
        public var pollVariableUsd: Double
        public var subscriptionChargesUsd: Double
        public var planFixedUsd: Double
        public var spentUsd: Double
        public var monthlyBudgetUsd: Double?
        public var projectedEomUsd: Double?
        public var level: SpendLevel
        public var isActive: Bool
        public var lastFetchAt: Date?
        public var lastFetchError: String?
        public var adapterKind: String
        public var statusNote: String?
    }

    public enum SpendLevel: String, Sendable, Equatable {
        case unconfigured
        case ok
        case warning
        case exceeded
    }

    public struct Summary: Equatable, Sendable {
        public var monthStart: Date
        public var providers: [ProviderSpend]
        public var totalSpentUsd: Double
        public var totalBudgetUsd: Double?
        public var overBudget: Bool
    }

    public static func compute(
        providers: [LocalProvider],
        plans: [String: LocalProviderPlan],
        snapshots: [LocalUsageSnapshot],
        subscriptions: [LocalSubscription],
        charges: [LocalSubscriptionCharge],
        now: Date = Date()
    ) -> Summary {
        let monthStart = utcMonthStart(now)
        let nextMonth = nextUtcMonth(after: monthStart)
        let elapsed = max(0, now.timeIntervalSince(monthStart))
        let monthLen = max(1, nextMonth.timeIntervalSince(monthStart))
        let fraction = elapsed / monthLen

        let snapsByProvider = Dictionary(grouping: snapshots, by: \.providerId)
        let chargesByProvider = Dictionary(grouping: charges, by: \.providerId)
        let subsByProvider = Dictionary(grouping: subscriptions, by: \.providerId)

        var rows: [ProviderSpend] = []
        for p in providers {
            let eligible = latestEligibleSnapshot(
                snapsByProvider[p.id] ?? [],
                monthStart: monthStart
            )
            var pollVariable = 0.0
            if let s = eligible, let total = s.totalCost {
                pollVariable = max(0, total - (s.fixedCostIncludedUsd ?? 0))
            }

            let monthCharges = (chargesByProvider[p.id] ?? []).filter {
                $0.periodStart >= monthStart && $0.periodStart < nextMonth
            }
            let subCharges = monthCharges.reduce(0.0) { $0 + $1.costUsd }

            let subs = subsByProvider[p.id] ?? []
            let hasActiveOrConsidering = subs.contains {
                ($0.status == "active" || $0.status == "considering") && $0.costUsd > 0
            }
            let plan = plans[p.id]
            var planFixed = 0.0
            if let fixed = plan?.fixedMonthlyCostUsd, fixed > 0, !hasActiveOrConsidering {
                planFixed = fixed
            }

            let spent = pollVariable + subCharges + planFixed
            let budget = plan?.monthlyBudgetUsd
            let level = spendLevel(spent: spent, budget: budget)

            var projected: Double?
            if fraction >= 0.02 {
                let remaining = max(0, 1 - fraction)
                let varProj = (pollVariable / fraction) * remaining
                projected = pollVariable + varProj + subCharges + planFixed
            }

            rows.append(
                ProviderSpend(
                    providerId: p.id,
                    displayName: p.displayName,
                    pollVariableUsd: pollVariable,
                    subscriptionChargesUsd: subCharges,
                    planFixedUsd: planFixed,
                    spentUsd: spent,
                    monthlyBudgetUsd: budget,
                    projectedEomUsd: projected,
                    level: level,
                    isActive: p.isActive,
                    lastFetchAt: p.lastFetchAt,
                    lastFetchError: p.lastFetchError,
                    adapterKind: p.adapterKind,
                    statusNote: nil
                )
            )
        }

        rows.sort { $0.spentUsd > $1.spentUsd }
        let totalSpent = rows.reduce(0.0) { $0 + $1.spentUsd }
        let budgets = rows.compactMap(\.monthlyBudgetUsd)
        let totalBudget: Double? = budgets.isEmpty ? nil : budgets.reduce(0, +)
        let over = rows.contains { $0.level == .exceeded }

        return Summary(
            monthStart: monthStart,
            providers: rows,
            totalSpentUsd: totalSpent,
            totalBudgetUsd: totalBudget,
            overBudget: over
        )
    }

    /// Design §2.3.2 eligibility (no grace).
    public static func latestEligibleSnapshot(
        _ snapshots: [LocalUsageSnapshot],
        monthStart: Date
    ) -> LocalUsageSnapshot? {
        let sorted = snapshots.sorted { $0.fetchedAt > $1.fetchedAt }

        if let cal = sorted.first(where: { s in
            guard s.totalCost != nil else { return false }
            guard s.costScope == "calendar_month_to_date" else { return false }
            if let w = s.costWindowStart, w < monthStart { return false }
            return true
        }) {
            return cal
        }

        if let unk = sorted.first(where: { s in
            guard s.totalCost != nil else { return false }
            guard s.costScope == "unknown" else { return false }
            return s.fetchedAt >= monthStart
        }) {
            return unk
        }

        return nil
    }

    public static func spendLevel(spent: Double, budget: Double?) -> SpendLevel {
        guard let budget, budget > 0 else { return .unconfigured }
        let pct = spent / budget
        if pct >= 1 { return .exceeded }
        if pct >= 0.8 { return .warning }
        return .ok
    }

    public static func utcMonthStart(_ date: Date = Date()) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month], from: date)
        return cal.date(from: DateComponents(year: c.year, month: c.month, day: 1))!
    }

    public static func nextUtcMonth(after start: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        return cal.date(byAdding: .month, value: 1, to: start)!
    }
}
