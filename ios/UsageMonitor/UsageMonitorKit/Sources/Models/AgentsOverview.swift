import Foundation

public struct AgentsSummary: Codable, Hashable, Sendable {
    public var activeAgentCount: Int
    public var totalAgentCount: Int
    public var totalTokens: Int
    public var totalApiEquivalentCostUsd: Double
    public var totalSubscriptionCostUsd: Double
    public var totalNetSavingsUsd: Double
    public var savingsMultiplier: Double
    public var topModel: String?

    public init(
        activeAgentCount: Int,
        totalAgentCount: Int,
        totalTokens: Int,
        totalApiEquivalentCostUsd: Double,
        totalSubscriptionCostUsd: Double,
        totalNetSavingsUsd: Double,
        savingsMultiplier: Double,
        topModel: String? = nil
    ) {
        self.activeAgentCount = activeAgentCount
        self.totalAgentCount = totalAgentCount
        self.totalTokens = totalTokens
        self.totalApiEquivalentCostUsd = totalApiEquivalentCostUsd
        self.totalSubscriptionCostUsd = totalSubscriptionCostUsd
        self.totalNetSavingsUsd = totalNetSavingsUsd
        self.savingsMultiplier = savingsMultiplier
        self.topModel = topModel
    }
}

public struct Burn5hSummary: Codable, Hashable, Sendable {
    public var tokens5h: Int
    public var costEstimate5hUsd: Double
    public var burnRateTokensPerHour: Int
    public var burnRateUsdPerHour: Double

    public init(
        tokens5h: Int,
        costEstimate5hUsd: Double,
        burnRateTokensPerHour: Int,
        burnRateUsdPerHour: Double
    ) {
        self.tokens5h = tokens5h
        self.costEstimate5hUsd = costEstimate5hUsd
        self.burnRateTokensPerHour = burnRateTokensPerHour
        self.burnRateUsdPerHour = burnRateUsdPerHour
    }
}

public struct AgentModelUsed: Codable, Hashable, Sendable, Identifiable {
    public var id: String { model }
    public var model: String
    public var tokens: Int
    public var percentOfPlatform: Double
    public var apiEquivalentCostUsd: Double

    public init(model: String, tokens: Int, percentOfPlatform: Double, apiEquivalentCostUsd: Double) {
        self.model = model
        self.tokens = tokens
        self.percentOfPlatform = percentOfPlatform
        self.apiEquivalentCostUsd = apiEquivalentCostUsd
    }
}

public struct AgentPlatformStatus: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var provider: String
    public var isRunningOnMac: Bool
    public var macStatus: String
    public var dataCapability: String
    public var fidelityTier: String
    public var notes: String
    public var monthlySeatCostUsd: Double
    public var totalTokens: Int
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int
    public var apiEquivalentCostUsd: Double
    public var reportedCostUsd: Double
    public var estimatedCostUsd: Double
    public var netSavingsUsd: Double
    public var modelsUsed: [AgentModelUsed]

    public init(
        id: String,
        name: String,
        provider: String,
        isRunningOnMac: Bool,
        macStatus: String,
        dataCapability: String,
        fidelityTier: String,
        notes: String,
        monthlySeatCostUsd: Double,
        totalTokens: Int,
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheCreationTokens: Int,
        apiEquivalentCostUsd: Double,
        reportedCostUsd: Double,
        estimatedCostUsd: Double,
        netSavingsUsd: Double,
        modelsUsed: [AgentModelUsed] = []
    ) {
        self.id = id
        self.name = name
        self.provider = provider
        self.isRunningOnMac = isRunningOnMac
        self.macStatus = macStatus
        self.dataCapability = dataCapability
        self.fidelityTier = fidelityTier
        self.notes = notes
        self.monthlySeatCostUsd = monthlySeatCostUsd
        self.totalTokens = totalTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.apiEquivalentCostUsd = apiEquivalentCostUsd
        self.reportedCostUsd = reportedCostUsd
        self.estimatedCostUsd = estimatedCostUsd
        self.netSavingsUsd = netSavingsUsd
        self.modelsUsed = modelsUsed
    }
}

public struct ModelDistributionItem: Codable, Hashable, Sendable, Identifiable {
    public var id: String { model }
    public var model: String
    public var provider: String
    public var tokens: Int
    public var percent: Double
    public var apiEquivalentCostUsd: Double

    public init(model: String, provider: String, tokens: Int, percent: Double, apiEquivalentCostUsd: Double) {
        self.model = model
        self.provider = provider
        self.tokens = tokens
        self.percent = percent
        self.apiEquivalentCostUsd = apiEquivalentCostUsd
    }
}

public struct AgentsOverviewResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var windowDays: Double
    public var windowLabel: String
    public var generatedAt: String
    public var macHostname: String
    public var macChip: String
    public var summary: AgentsSummary
    public var burn5h: Burn5hSummary
    public var platforms: [AgentPlatformStatus]
    public var modelDistribution: [ModelDistributionItem]

    public init(
        ok: Bool,
        windowDays: Double,
        windowLabel: String,
        generatedAt: String,
        macHostname: String,
        macChip: String,
        summary: AgentsSummary,
        burn5h: Burn5hSummary,
        platforms: [AgentPlatformStatus],
        modelDistribution: [ModelDistributionItem]
    ) {
        self.ok = ok
        self.windowDays = windowDays
        self.windowLabel = windowLabel
        self.generatedAt = generatedAt
        self.macHostname = macHostname
        self.macChip = macChip
        self.summary = summary
        self.burn5h = burn5h
        self.platforms = platforms
        self.modelDistribution = modelDistribution
    }

    public static let sample = AgentsOverviewResponse(
        ok: true,
        windowDays: 7.0,
        windowLabel: "Last 7 Days",
        generatedAt: "2026-08-24T05:00:00.000Z",
        macHostname: "jays.services (jay · macbook.boa-roygbiv.ts.net)",
        macChip: "Apple M5",
        summary: AgentsSummary(
            activeAgentCount: 6,
            totalAgentCount: 6,
            totalTokens: 42_500_000,
            totalApiEquivalentCostUsd: 148.50,
            totalSubscriptionCostUsd: 60.00,
            totalNetSavingsUsd: 88.50,
            savingsMultiplier: 2.48,
            topModel: "claude-3-7-sonnet"
        ),
        burn5h: Burn5hSummary(
            tokens5h: 1_250_000,
            costEstimate5hUsd: 4.85,
            burnRateTokensPerHour: 250_000,
            burnRateUsdPerHour: 0.97
        ),
        platforms: [
            AgentPlatformStatus(
                id: "claude",
                name: "Claude Code / Desktop",
                provider: "Anthropic",
                isRunningOnMac: true,
                macStatus: "Active on Mac",
                dataCapability: "Full OTLP Telemetry & Ingest",
                fidelityTier: "full_telemetry",
                notes: "Detailed token and cost analytics via OTLP metrics stream.",
                monthlySeatCostUsd: 20.0,
                totalTokens: 28_400_000,
                inputTokens: 18_200_000,
                outputTokens: 4_200_000,
                cacheReadTokens: 5_000_000,
                cacheCreationTokens: 1_000_000,
                apiEquivalentCostUsd: 112.20,
                reportedCostUsd: 108.40,
                estimatedCostUsd: 112.20,
                netSavingsUsd: 92.20,
                modelsUsed: [
                    AgentModelUsed(model: "claude-3-7-sonnet", tokens: 22_000_000, percentOfPlatform: 77.5, apiEquivalentCostUsd: 95.40),
                    AgentModelUsed(model: "claude-3-5-haiku", tokens: 6_400_000, percentOfPlatform: 22.5, apiEquivalentCostUsd: 16.80)
                ]
            ),
            AgentPlatformStatus(
                id: "cursor",
                name: "Cursor",
                provider: "Cursor / Anysphere",
                isRunningOnMac: true,
                macStatus: "Active on Mac",
                dataCapability: "Live Process & Ingest Attribution",
                fidelityTier: "pushed_ingest",
                notes: "Usage attributed via project telemetry ingest stream.",
                monthlySeatCostUsd: 20.0,
                totalTokens: 8_200_000,
                inputTokens: 6_000_000,
                outputTokens: 2_200_000,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                apiEquivalentCostUsd: 24.60,
                reportedCostUsd: 24.60,
                estimatedCostUsd: 24.60,
                netSavingsUsd: 4.60,
                modelsUsed: [
                    AgentModelUsed(model: "claude-3-7-sonnet", tokens: 6_200_000, percentOfPlatform: 75.6, apiEquivalentCostUsd: 19.80),
                    AgentModelUsed(model: "gpt-4o", tokens: 2_000_000, percentOfPlatform: 24.4, apiEquivalentCostUsd: 4.80)
                ]
            ),
            AgentPlatformStatus(
                id: "grok",
                name: "Grok Build & Leader",
                provider: "xAI",
                isRunningOnMac: true,
                macStatus: "Active on Mac",
                dataCapability: "Live Process & Pushed Telemetry",
                fidelityTier: "pushed_ingest",
                notes: "Token telemetry captured via xAI push adapter.",
                monthlySeatCostUsd: 20.0,
                totalTokens: 5_900_000,
                inputTokens: 4_500_000,
                outputTokens: 1_400_000,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                apiEquivalentCostUsd: 11.70,
                reportedCostUsd: 11.70,
                estimatedCostUsd: 11.70,
                netSavingsUsd: -8.30,
                modelsUsed: [
                    AgentModelUsed(model: "grok-2", tokens: 5_900_000, percentOfPlatform: 100.0, apiEquivalentCostUsd: 11.70)
                ]
            )
        ],
        modelDistribution: [
            ModelDistributionItem(model: "claude-3-7-sonnet", provider: "anthropic", tokens: 28_200_000, percent: 66.4, apiEquivalentCostUsd: 115.20),
            ModelDistributionItem(model: "claude-3-5-haiku", provider: "anthropic", tokens: 6_400_000, percent: 15.1, apiEquivalentCostUsd: 16.80),
            ModelDistributionItem(model: "grok-2", provider: "xai", tokens: 5_900_000, percent: 13.9, apiEquivalentCostUsd: 11.70),
            ModelDistributionItem(model: "gpt-4o", provider: "openai", tokens: 2_000_000, percent: 4.7, apiEquivalentCostUsd: 4.80)
        ]
    )
}
