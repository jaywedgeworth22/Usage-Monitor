import Foundation

public struct LlmBurnTokenTotals: Codable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double?
    public var cacheCreation: Double?
    public var unknown: Double?
    public var total: Double
}

public struct LlmBurnWindowReport: Codable, Hashable, Sendable {
    public var hours: Double
    public var tokens: LlmBurnTokenTotals
    public var derivedCostUsd: Double?
    public var reportedCostUsd: Double?
    public var estimateUsd: Double?
    public var eventCount: Int?
    public var tokensPerHour: Double?
    public var usdPerHour: Double?
}

public struct LlmBurnBudgetPace: Codable, Hashable, Sendable {
    public var monthlyBudgetUsd: Double?
    public var status: String?
    public var projectedMonthEndUsd: Double?
}

public struct LlmBurnProviderReport: Codable, Hashable, Sendable, Identifiable {
    public var provider: String
    public var window: LlmBurnWindowReport
    public var budget: LlmBurnBudgetPace?
    public var id: String { provider }
}

public struct LlmBurnResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var generatedAt: String?
    public var windowHours: Double?
    public var providers: [LlmBurnProviderReport]
    public var quietProviders: [LlmBurnProviderReport]?

    public var hasActivity: Bool {
        !providers.isEmpty || !(quietProviders ?? []).isEmpty
    }
}
