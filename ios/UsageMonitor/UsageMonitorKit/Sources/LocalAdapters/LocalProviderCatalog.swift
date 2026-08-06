import Foundation

/// Fleet-aware catalog for **Local Usage Monitor**.
/// Modes match server reality: true poll cost vs subscription/manual tracking.
public enum LocalProviderMode: String, Sendable, Codable, CaseIterable {
    /// API key poll can produce budget-facing MTD cost (or balance).
    case poll
    /// Fixed recurring fee only (materialized subscription charges).
    case subscription
    /// Optional API key for connectivity; cost via subscription if set.
    case keyPlusSubscription
}

public struct LocalProviderCatalogEntry: Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var displayName: String
    public var category: String
    public var mode: LocalProviderMode
    /// Adapter kind for poll (`openrouter`, `deepseek`, …) or `subscription_only`.
    public var adapterKind: String
    public var keyFieldLabel: String
    public var help: String
    public var suggestedMonthlyUsd: Double?
    public var suggestedSubscriptionName: String?

    public init(
        name: String,
        displayName: String,
        category: String,
        mode: LocalProviderMode,
        adapterKind: String,
        keyFieldLabel: String = "API key",
        help: String,
        suggestedMonthlyUsd: Double? = nil,
        suggestedSubscriptionName: String? = nil
    ) {
        self.name = name
        self.displayName = displayName
        self.category = category
        self.mode = mode
        self.adapterKind = adapterKind
        self.keyFieldLabel = keyFieldLabel
        self.help = help
        self.suggestedMonthlyUsd = suggestedMonthlyUsd
        self.suggestedSubscriptionName = suggestedSubscriptionName
    }
}

public enum LocalProviderCatalog {
    public static let all: [LocalProviderCatalogEntry] = [
        // —— LLM / AI ——
        .init(
            name: "openrouter",
            displayName: "OpenRouter",
            category: "LLM",
            mode: .poll,
            adapterKind: "openrouter",
            keyFieldLabel: "Management API key",
            help: "Management/Provisioning key for MTD spend. Inference-only keys connect but report $0 poll spend."
        ),
        .init(
            name: "openai",
            displayName: "OpenAI",
            category: "LLM",
            mode: .poll,
            adapterKind: "openai",
            keyFieldLabel: "Org Admin API key",
            help: "Organization Admin key for Costs API (month-to-date USD)."
        ),
        .init(
            name: "anthropic",
            displayName: "Anthropic (API / Admin)",
            category: "LLM",
            mode: .poll,
            adapterKind: "anthropic",
            keyFieldLabel: "Admin API key (sk-ant-admin…)",
            help: "Org Admin cost report only. Personal Claude Max/Pro → use Claude subscription row."
        ),
        .init(
            name: "anthropic-claude-sub",
            displayName: "Claude (subscription)",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Apple/Anthropic billed Max/Pro/Team — no personal usage poll.",
            suggestedMonthlyUsd: 200,
            suggestedSubscriptionName: "Claude plan"
        ),
        .init(
            name: "deepseek",
            displayName: "DeepSeek",
            category: "LLM",
            mode: .poll,
            adapterKind: "deepseek",
            help: "Account balance (USD). Cost MTD not exposed — balance only."
        ),
        .init(
            name: "xai",
            displayName: "xAI / Grok",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Full billing needs Management key + teamId (server). Track plan fee here; poll later.",
            suggestedMonthlyUsd: nil,
            suggestedSubscriptionName: "xAI plan"
        ),
        .init(
            name: "mistral",
            displayName: "Mistral",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Admin console spend is complex on phone v1 — track subscription/budget here.",
            suggestedSubscriptionName: "Mistral plan"
        ),
        .init(
            name: "google-ai",
            displayName: "Google AI / Gemini",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Cloud Billing export is server-side. Track quota/subscription cost here.",
            suggestedSubscriptionName: "Gemini / Google AI"
        ),
        .init(
            name: "voyage",
            displayName: "Voyage AI",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "No public usage/billing API (remote is push/manual too). Track prepaid credits or plan fee here; push cost events on the server if you have them.",
            suggestedSubscriptionName: "Voyage"
        ),

        // —— Hosting / cloud ——
        .init(
            name: "cloudflare",
            displayName: "Cloudflare",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track Workers Paid or other plan fees only if you actually pay them. Free tier and unused accounts should stay $0.",
            suggestedMonthlyUsd: nil,
            suggestedSubscriptionName: "Workers Paid"
        ),
        .init(
            name: "render",
            displayName: "Render",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Server polls Render API; phone tracks instance plan fees.",
            suggestedSubscriptionName: "Render services"
        ),
        .init(
            name: "vercel",
            displayName: "Vercel",
            category: "Hosting",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "FOCUS/project billing is server-side. Leave $0 unless you pay for Pro/Enterprise — do not invent a Pro fee.",
            suggestedMonthlyUsd: nil,
            suggestedSubscriptionName: "Vercel plan"
        ),
        .init(
            name: "hetzner",
            displayName: "Hetzner Cloud",
            category: "Hosting",
            mode: .poll,
            adapterKind: "hetzner",
            keyFieldLabel: "Project API token",
            help: "Polls inventory + public pricing catalog; pro-rates into estimated MTD (not an invoice). One token per Hetzner project."
        ),
        .init(
            name: "oracle",
            displayName: "Oracle Cloud Infrastructure",
            category: "Hosting",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Live USD cost needs OCI RSA signing (remote Usage Monitor only). On phone: track paid add-ons / Always Free $0 here.",
            suggestedSubscriptionName: "OCI"
        ),
        .init(
            name: "coolify",
            displayName: "Coolify",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Self-hosted control plane; optional server-stats token on fleet server.",
            suggestedSubscriptionName: "Coolify host"
        ),
        .init(
            name: "deno",
            displayName: "Deno Deploy",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Limited poll on server; track plan if paid.",
            suggestedSubscriptionName: "Deno Deploy"
        ),
        .init(
            name: "github",
            displayName: "GitHub",
            category: "Dev tools",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Copilot / org billing is server adapter. Track Copilot or Teams seats here.",
            suggestedMonthlyUsd: 10,
            suggestedSubscriptionName: "GitHub Copilot"
        ),

        // —— Data / market ——
        .init(
            name: "fmp",
            displayName: "Financial Modeling Prep",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind on server (no $ poll). Track paid tier as subscription.",
            suggestedMonthlyUsd: 0,
            suggestedSubscriptionName: "FMP plan"
        ),
        .init(
            name: "tiingo",
            displayName: "Tiingo",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind on server. Track paid tier if any.",
            suggestedSubscriptionName: "Tiingo"
        ),
        .init(
            name: "finnhub",
            displayName: "Finnhub",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Rate-limit based free tier; track paid plan if used.",
            suggestedSubscriptionName: "Finnhub"
        ),
        .init(
            name: "alphavantage",
            displayName: "Alpha Vantage",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind / rate-limit; track premium if any.",
            suggestedSubscriptionName: "Alpha Vantage"
        ),
        .init(
            name: "twelvedata",
            displayName: "Twelve Data",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track paid credits plan as subscription.",
            suggestedSubscriptionName: "Twelve Data"
        ),
        .init(
            name: "marketstack",
            displayName: "Marketstack",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind on server. Track paid tier.",
            suggestedSubscriptionName: "Marketstack"
        ),
        .init(
            name: "massive",
            displayName: "Massive",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind on server. Track paid tier.",
            suggestedSubscriptionName: "Massive"
        ),
        .init(
            name: "fred",
            displayName: "FRED",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Free API; track only if you pay for something related.",
            suggestedSubscriptionName: "FRED"
        ),
        .init(
            name: "quiver-quant",
            displayName: "Quiver Quant",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track subscription plan.",
            suggestedSubscriptionName: "Quiver Quant"
        ),
        .init(
            name: "roic",
            displayName: "ROIC.ai",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Blind on server (no usage poll). Track plan as subscription.",
            suggestedSubscriptionName: "ROIC.ai"
        ),
        .init(
            name: "intrinio",
            displayName: "Intrinio",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Historical / limited API — track paid plan if used.",
            suggestedSubscriptionName: "Intrinio"
        ),
        .init(
            name: "fintech-studios",
            displayName: "FinTech Studios",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track plan/credits if used.",
            suggestedSubscriptionName: "FinTech Studios"
        ),
        .init(
            name: "unusual-whales",
            displayName: "Unusual Whales",
            category: "Market data",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track paid plan; server has usage adapter.",
            suggestedSubscriptionName: "Unusual Whales"
        ),
        .init(
            name: "tradier",
            displayName: "Tradier",
            category: "Brokerage",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Brokerage equity is not API spend — track account fees if needed.",
            suggestedSubscriptionName: "Tradier"
        ),
        .init(
            name: "alpaca",
            displayName: "Alpaca",
            category: "Brokerage",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track market data subscriptions if paid.",
            suggestedSubscriptionName: "Alpaca"
        ),
        .init(
            name: "robinhood",
            displayName: "Robinhood",
            category: "Brokerage",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Brokerage account balance is not a usage cost. Only add a fee if you pay Robinhood Gold (or similar) — leave $0 otherwise.",
            suggestedMonthlyUsd: nil,
            suggestedSubscriptionName: "Robinhood Gold"
        ),

        // —— Infra / observability ——
        .init(
            name: "pinecone",
            displayName: "Pinecone",
            category: "Infra",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Server inventories indexes; track Standard/Enterprise plan fee.",
            suggestedSubscriptionName: "Pinecone"
        ),
        .init(
            name: "sentry",
            displayName: "Sentry",
            category: "Observability",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track Team/Business plan.",
            suggestedSubscriptionName: "Sentry"
        ),
        .init(
            name: "langfuse",
            displayName: "Langfuse",
            category: "Observability",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track cloud plan if used.",
            suggestedSubscriptionName: "Langfuse"
        ),
        .init(
            name: "stripe",
            displayName: "Stripe",
            category: "Payments",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Fees are % of volume — track estimated monthly ops cost if useful.",
            suggestedSubscriptionName: "Stripe (est.)"
        ),
        .init(
            name: "twilio",
            displayName: "Twilio",
            category: "Comms",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track estimated monthly SMS/voice spend.",
            suggestedSubscriptionName: "Twilio"
        ),
        .init(
            name: "resend",
            displayName: "Resend",
            category: "Comms",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track email plan.",
            suggestedSubscriptionName: "Resend"
        ),
        .init(
            name: "pushover",
            displayName: "Pushover",
            category: "Comms",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "One-time license or multi-app; track if renewing.",
            suggestedSubscriptionName: "Pushover"
        ),
        .init(
            name: "apify",
            displayName: "Apify",
            category: "Data",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track platform plan.",
            suggestedSubscriptionName: "Apify"
        ),
        .init(
            name: "firecrawl",
            displayName: "Firecrawl",
            category: "Data",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track credits plan.",
            suggestedSubscriptionName: "Firecrawl"
        ),
        .init(
            name: "llamaindex",
            displayName: "LlamaIndex Cloud",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "subscription_only",
            help: "Track cloud plan.",
            suggestedSubscriptionName: "LlamaIndex"
        ),
        .init(
            name: "agent-sync-relay",
            displayName: "Agent Sync Relay",
            category: "Fleet",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Built-in fleet relay — usually $0.",
            suggestedMonthlyUsd: 0,
            suggestedSubscriptionName: "Agent Sync"
        ),
        .init(
            name: "cursor",
            displayName: "Cursor",
            category: "Dev tools",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "IDE subscription (common fleet cost).",
            suggestedMonthlyUsd: 20,
            suggestedSubscriptionName: "Cursor Pro"
        ),
        .init(
            name: "custom",
            displayName: "Custom / other",
            category: "Other",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Any other recurring tool cost.",
            suggestedSubscriptionName: "Custom subscription"
        ),
    ]

    public static var categories: [String] {
        Array(Set(all.map(\.category))).sorted()
    }

    public static func entry(name: String) -> LocalProviderCatalogEntry? {
        all.first { $0.name == name }
    }

    public static func filtered(search: String) -> [LocalProviderCatalogEntry] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter {
            $0.displayName.lowercased().contains(q)
                || $0.name.contains(q)
                || $0.category.lowercased().contains(q)
        }
    }
}
