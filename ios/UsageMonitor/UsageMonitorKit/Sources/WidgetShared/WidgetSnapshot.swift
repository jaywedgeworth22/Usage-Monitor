import Foundation

/// A compact, self-contained projection of budget status that the WidgetKit
/// extension can render without pulling in the app's full model/networking
/// stack. The app derives and persists this after every successful refresh.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Meter: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var spentUsd: Double
        public var budgetUsd: Double?
        public var percentUsed: Double?
        /// Raw status string: "ok" | "warning" | "exceeded" | "unconfigured".
        public var status: String
        /// Projected end-of-month spend when known (projects / overall).
        public var projectedEomUsd: Double?

        public init(
            id: String,
            name: String,
            spentUsd: Double,
            budgetUsd: Double?,
            percentUsed: Double?,
            status: String,
            projectedEomUsd: Double? = nil
        ) {
            self.id = id
            self.name = name
            self.spentUsd = spentUsd
            self.budgetUsd = budgetUsd
            self.percentUsed = percentUsed
            self.status = status
            self.projectedEomUsd = projectedEomUsd
        }

        private enum CodingKeys: String, CodingKey {
            case id, name, spentUsd, budgetUsd, percentUsed, status, projectedEomUsd
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decode(String.self, forKey: .name)
            spentUsd = try c.decode(Double.self, forKey: .spentUsd)
            budgetUsd = try c.decodeIfPresent(Double.self, forKey: .budgetUsd)
            percentUsed = try c.decodeIfPresent(Double.self, forKey: .percentUsed)
            status = try c.decode(String.self, forKey: .status)
            projectedEomUsd = try c.decodeIfPresent(Double.self, forKey: .projectedEomUsd)
        }
    }

    public var generatedAt: Date
    public var month: String
    /// Account-wide (provider-scoped) month-to-date totals.
    public var totalSpentUsd: Double
    public var totalBudgetUsd: Double
    public var projectedEomUsd: Double
    public var percentUsed: Double?
    public var overBudget: Bool
    public var warning: Bool
    /// Highest-utilisation **provider** budget meters for the overall view.
    public var topMeters: [Meter]
    /// Project budget rows the widget can focus on (may include unbudgeted).
    public var projects: [Meter]

    public init(
        generatedAt: Date,
        month: String,
        totalSpentUsd: Double,
        totalBudgetUsd: Double,
        projectedEomUsd: Double,
        percentUsed: Double?,
        overBudget: Bool,
        warning: Bool,
        topMeters: [Meter],
        projects: [Meter] = []
    ) {
        self.generatedAt = generatedAt
        self.month = month
        self.totalSpentUsd = totalSpentUsd
        self.totalBudgetUsd = totalBudgetUsd
        self.projectedEomUsd = projectedEomUsd
        self.percentUsed = percentUsed
        self.overBudget = overBudget
        self.warning = warning
        self.topMeters = topMeters
        self.projects = projects
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, month, totalSpentUsd, totalBudgetUsd, projectedEomUsd
        case percentUsed, overBudget, warning, topMeters, projects
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        month = try c.decode(String.self, forKey: .month)
        totalSpentUsd = try c.decode(Double.self, forKey: .totalSpentUsd)
        totalBudgetUsd = try c.decode(Double.self, forKey: .totalBudgetUsd)
        projectedEomUsd = try c.decode(Double.self, forKey: .projectedEomUsd)
        percentUsed = try c.decodeIfPresent(Double.self, forKey: .percentUsed)
        overBudget = try c.decode(Bool.self, forKey: .overBudget)
        warning = try c.decode(Bool.self, forKey: .warning)
        topMeters = try c.decode([Meter].self, forKey: .topMeters)
        // Backward-compatible: older snapshots omit projects.
        projects = try c.decodeIfPresent([Meter].self, forKey: .projects) ?? []
    }

    /// Deterministic **gallery/preview** sample (never used as a live empty state).
    public static let placeholder = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
        month: "2026-07",
        totalSpentUsd: 428.16,
        totalBudgetUsd: 900,
        projectedEomUsd: 690.40,
        percentUsed: 0.4757,
        overBudget: false,
        warning: true,
        topMeters: [
            Meter(id: "anthropic", name: "Anthropic", spentUsd: 212.4, budgetUsd: 250, percentUsed: 0.85, status: "warning", projectedEomUsd: 280),
            Meter(id: "openai", name: "OpenAI", spentUsd: 96.2, budgetUsd: 200, percentUsed: 0.48, status: "ok", projectedEomUsd: 140),
            Meter(id: "voyage", name: "Voyage", spentUsd: 61.0, budgetUsd: 150, percentUsed: 0.41, status: "ok", projectedEomUsd: 90)
        ],
        projects: [
            Meter(id: "proj-ct", name: "Congress.Trade", spentUsd: 180, budgetUsd: 400, percentUsed: 0.45, status: "ok", projectedEomUsd: 260),
            Meter(id: "proj-st", name: "Socratic.Trade", spentUsd: 95, budgetUsd: 200, percentUsed: 0.475, status: "ok", projectedEomUsd: 140)
        ]
    )

    /// Live empty state when no snapshot has been written (signed-out / fresh install).
    /// Zeros only — never fabricated spend that looks like real money.
    public static let empty = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 0),
        month: "",
        totalSpentUsd: 0,
        totalBudgetUsd: 0,
        projectedEomUsd: 0,
        percentUsed: nil,
        overBudget: false,
        warning: false,
        topMeters: [],
        projects: []
    )
}
