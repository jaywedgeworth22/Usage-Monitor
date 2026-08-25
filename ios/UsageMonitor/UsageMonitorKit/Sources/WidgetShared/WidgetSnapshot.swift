import Foundation

/// A compact, self-contained projection that the WidgetKit extension can
/// render without pulling in the app's full model/networking stack. The app
/// derives and persists this after every successful refresh.
///
/// Budget fields are the original payload.  LLM and server sections are
/// optional so older app-group files still decode.  Missing sections are
/// absent data, not zeros.
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

    /// Trailing-window LLM burn copied from `LlmBurnResponse`.  Cost fields
    /// stay optional so a missing estimate is not written as `$0`.
    public struct LlmSection: Codable, Equatable, Sendable {
        public var generatedAt: Date
        public var windowHours: Double?
        public var providers: [Provider]

        public init(generatedAt: Date, windowHours: Double?, providers: [Provider]) {
            self.generatedAt = generatedAt
            self.windowHours = windowHours
            self.providers = providers
        }

        public struct Provider: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var name: String
            public var quiet: Bool
            public var tokensTotal: Double
            public var tokensInput: Double
            public var tokensOutput: Double
            public var derivedCostUsd: Double?
            public var reportedCostUsd: Double?
            public var estimateUsd: Double?
            public var tokensPerHour: Double?
            public var usdPerHour: Double?
            public var monthlyBudgetUsd: Double?
            public var budgetStatus: String?
            public var projectedMonthEndUsd: Double?

            public init(
                id: String,
                name: String,
                quiet: Bool,
                tokensTotal: Double,
                tokensInput: Double,
                tokensOutput: Double,
                derivedCostUsd: Double? = nil,
                reportedCostUsd: Double? = nil,
                estimateUsd: Double? = nil,
                tokensPerHour: Double? = nil,
                usdPerHour: Double? = nil,
                monthlyBudgetUsd: Double? = nil,
                budgetStatus: String? = nil,
                projectedMonthEndUsd: Double? = nil
            ) {
                self.id = id
                self.name = name
                self.quiet = quiet
                self.tokensTotal = tokensTotal
                self.tokensInput = tokensInput
                self.tokensOutput = tokensOutput
                self.derivedCostUsd = derivedCostUsd
                self.reportedCostUsd = reportedCostUsd
                self.estimateUsd = estimateUsd
                self.tokensPerHour = tokensPerHour
                self.usdPerHour = usdPerHour
                self.monthlyBudgetUsd = monthlyBudgetUsd
                self.budgetStatus = budgetStatus
                self.projectedMonthEndUsd = projectedMonthEndUsd
            }
        }
    }

    /// Service probe + host/app inventory copied from `ServerHealth`,
    /// `ServerReadiness`, and `ServerMetrics`.  Each subsection has its own
    /// timestamp so a loaded service probe never pretends host metrics exist.
    public struct ServerSection: Codable, Equatable, Sendable {
        public var service: Service?
        public var host: Host?
        public var apps: [App]

        public init(service: Service? = nil, host: Host? = nil, apps: [App] = []) {
            self.service = service
            self.host = host
            self.apps = apps
        }

        public struct Check: Codable, Equatable, Sendable, Identifiable {
            public var name: String
            public var ok: Bool
            public var gatesService: Bool
            public var detail: String?
            public var freeBytes: Int64?
            public var totalBytes: Int64?

            public var id: String { name }

            public init(
                name: String,
                ok: Bool,
                gatesService: Bool,
                detail: String? = nil,
                freeBytes: Int64? = nil,
                totalBytes: Int64? = nil
            ) {
                self.name = name
                self.ok = ok
                self.gatesService = gatesService
                self.detail = detail
                self.freeBytes = freeBytes
                self.totalBytes = totalBytes
            }
        }

        public struct Service: Codable, Equatable, Sendable {
            public var generatedAt: Date
            public var name: String
            public var ok: Bool
            public var status: String
            public var uptimeSeconds: Int?
            public var readyOk: Bool?
            public var checks: [Check]

            public init(
                generatedAt: Date,
                name: String,
                ok: Bool,
                status: String,
                uptimeSeconds: Int? = nil,
                readyOk: Bool? = nil,
                checks: [Check] = []
            ) {
                self.generatedAt = generatedAt
                self.name = name
                self.ok = ok
                self.status = status
                self.uptimeSeconds = uptimeSeconds
                self.readyOk = readyOk
                self.checks = checks
            }
        }

        public struct Host: Codable, Equatable, Sendable {
            public var generatedAt: Date
            public var name: String?
            public var status: String?
            public var cpuPct: Double?
            public var memoryTotalBytes: Int64?
            public var diskUsedPct: Int?
            public var diskFreeBytes: Int64?
            public var diskTotalBytes: Int64?
            public var degraded: Bool
            public var stale: Bool
            public var preventionOverall: String?
            public var appsHealthy: Int?
            public var appsDown: Int?
            public var appsTotal: Int?

            public init(
                generatedAt: Date,
                name: String? = nil,
                status: String? = nil,
                cpuPct: Double? = nil,
                memoryTotalBytes: Int64? = nil,
                diskUsedPct: Int? = nil,
                diskFreeBytes: Int64? = nil,
                diskTotalBytes: Int64? = nil,
                degraded: Bool = false,
                stale: Bool = false,
                preventionOverall: String? = nil,
                appsHealthy: Int? = nil,
                appsDown: Int? = nil,
                appsTotal: Int? = nil
            ) {
                self.generatedAt = generatedAt
                self.name = name
                self.status = status
                self.cpuPct = cpuPct
                self.memoryTotalBytes = memoryTotalBytes
                self.diskUsedPct = diskUsedPct
                self.diskFreeBytes = diskFreeBytes
                self.diskTotalBytes = diskTotalBytes
                self.degraded = degraded
                self.stale = stale
                self.preventionOverall = preventionOverall
                self.appsHealthy = appsHealthy
                self.appsDown = appsDown
                self.appsTotal = appsTotal
            }
        }

        public struct App: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var name: String
            public var status: String
            public var selfApp: Bool

            public init(id: String, name: String, status: String, selfApp: Bool) {
                self.id = id
                self.name = name
                self.status = status
                self.selfApp = selfApp
            }
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
    /// Trailing-window LLM burn.  `nil` means the app has never cached it.
    public var llm: LlmSection?
    /// Service / host / app rows.  `nil` means the app has never cached them.
    public var servers: ServerSection?

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
        projects: [Meter] = [],
        llm: LlmSection? = nil,
        servers: ServerSection? = nil
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
        self.llm = llm
        self.servers = servers
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, month, totalSpentUsd, totalBudgetUsd, projectedEomUsd
        case percentUsed, overBudget, warning, topMeters, projects, llm, servers
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
        // Backward-compatible: older snapshots omit projects / llm / servers.
        projects = try c.decodeIfPresent([Meter].self, forKey: .projects) ?? []
        llm = try c.decodeIfPresent(LlmSection.self, forKey: .llm)
        servers = try c.decodeIfPresent(ServerSection.self, forKey: .servers)
    }

    /// Keep LLM / server cache when a budget-only write lands.
    public func mergingPreservedSections(from existing: WidgetSnapshot) -> WidgetSnapshot {
        var next = self
        if next.llm == nil { next.llm = existing.llm }
        if next.servers == nil { next.servers = existing.servers }
        return next
    }

    public func replacingLlm(_ llm: LlmSection?) -> WidgetSnapshot {
        var next = self
        next.llm = llm
        return next
    }

    public func replacingServerService(_ service: ServerSection.Service?) -> WidgetSnapshot {
        var next = self
        var section = next.servers ?? ServerSection()
        section.service = service
        next.servers = section
        return next
    }

    public func replacingServerHost(_ host: ServerSection.Host?, apps: [ServerSection.App]) -> WidgetSnapshot {
        var next = self
        var section = next.servers ?? ServerSection()
        section.host = host
        section.apps = apps
        next.servers = section
        return next
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
        ],
        llm: LlmSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            windowHours: 5,
            providers: [
                LlmSection.Provider(
                    id: "anthropic",
                    name: "anthropic",
                    quiet: false,
                    tokensTotal: 184_200,
                    tokensInput: 120_000,
                    tokensOutput: 64_200,
                    derivedCostUsd: 8.40,
                    reportedCostUsd: 8.10,
                    estimateUsd: 8.40,
                    tokensPerHour: 36_840,
                    usdPerHour: 1.68,
                    monthlyBudgetUsd: 250,
                    budgetStatus: "watch",
                    projectedMonthEndUsd: 280
                ),
                LlmSection.Provider(
                    id: "openai",
                    name: "openai",
                    quiet: false,
                    tokensTotal: 42_000,
                    tokensInput: 30_000,
                    tokensOutput: 12_000,
                    estimateUsd: 2.10,
                    tokensPerHour: 8_400,
                    usdPerHour: 0.42,
                    monthlyBudgetUsd: 200,
                    budgetStatus: "on-pace",
                    projectedMonthEndUsd: 140
                ),
                LlmSection.Provider(
                    id: "voyage",
                    name: "voyage",
                    quiet: true,
                    tokensTotal: 0,
                    tokensInput: 0,
                    tokensOutput: 0,
                    monthlyBudgetUsd: 150,
                    budgetStatus: "no-budget"
                )
            ]
        ),
        servers: ServerSection(
            service: ServerSection.Service(
                generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
                name: "usage-monitor",
                ok: true,
                status: "live",
                uptimeSeconds: 84_213,
                readyOk: true,
                checks: [
                    ServerSection.Check(name: "Database", ok: true, gatesService: true),
                    ServerSection.Check(name: "Scheduler", ok: true, gatesService: true),
                    ServerSection.Check(
                        name: "Disk",
                        ok: true,
                        gatesService: false,
                        freeBytes: 30_000_000_000,
                        totalBytes: 160_000_000_000
                    )
                ]
            ),
            host: ServerSection.Host(
                generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
                name: "ubuntu-16gb-nbg1-cx43",
                status: "running",
                cpuPct: 18.5,
                memoryTotalBytes: 16 * 1024 * 1024 * 1024,
                diskUsedPct: 81,
                diskFreeBytes: 30_000_000_000,
                diskTotalBytes: 160_000_000_000,
                degraded: false,
                stale: false,
                preventionOverall: "ok",
                appsHealthy: 2,
                appsDown: 0,
                appsTotal: 3
            ),
            apps: [
                ServerSection.App(id: "um", name: "usage-monitor", status: "running:healthy", selfApp: true),
                ServerSection.App(id: "st", name: "socratic-app", status: "running:healthy", selfApp: false),
                ServerSection.App(id: "ct", name: "congress-trade", status: "running:unknown", selfApp: false)
            ]
        )
    )

    /// Live empty state when no snapshot has been written (signed-out / fresh install).
    /// Zeros only — never fabricated spend that looks like real money.
    /// LLM and server sections stay `nil` so those topics cannot show fake live zeros.
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
        projects: [],
        llm: nil,
        servers: nil
    )
}
