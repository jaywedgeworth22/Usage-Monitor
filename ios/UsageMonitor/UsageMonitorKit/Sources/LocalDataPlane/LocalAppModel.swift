import Foundation
import Observation
import LocalStore
import LocalSecrets
import LocalAdapters
import LocalBudget

/// Orchestrates Local store, polls, materializer, and BudgetEngine.
@MainActor
@Observable
public final class LocalAppModel {
    public private(set) var isReady = false
    public private(set) var schemaVersion = 0
    public private(set) var summary: BudgetEngine.Summary?
    public private(set) var providers: [LocalProvider] = []
    public private(set) var subscriptions: [LocalSubscription] = []
    public private(set) var projects: [LocalProject] = []
    public private(set) var alerts: [LocalAlertItem] = []
    public private(set) var lastError: String?
    public private(set) var isRefreshing = false
    public private(set) var lastMaterializedCharges = 0

    public let store: SQLiteLocalStore
    public let secrets: ProviderSecretStoring

    public init(
        store: SQLiteLocalStore = .shared,
        secrets: ProviderSecretStoring = ProviderKeychainStore.shared
    ) {
        self.store = store
        self.secrets = secrets
    }

    public func bootstrap() async {
        do {
            try await store.open()
            schemaVersion = await store.schemaVersion
            // Heal seed-invented catalog-guess fees before materialize.
            _ = try await scrubCatalogGuessCharges(reloadAfter: false)
            lastMaterializedCharges = try await SubscriptionMaterializer.materialize(store: store)
            try await reload()
            isReady = true
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func reload() async throws {
        providers = try await store.listProviders()
        subscriptions = try await store.listSubscriptions()
        projects = try await store.listProjects()
        let plans = try await loadPlans()
        let snaps = try await store.allSnapshots()
        let charges = try await store.allCharges()
        let computed = BudgetEngine.compute(
            providers: providers,
            plans: plans,
            snapshots: snaps,
            subscriptions: subscriptions,
            charges: charges
        )
        summary = computed
        alerts = LocalAlertBuilder.build(
            summary: computed,
            providers: providers,
            projects: projects
        )
        lastError = nil
    }

    private func loadPlans() async throws -> [String: LocalProviderPlan] {
        var map: [String: LocalProviderPlan] = [:]
        for p in try await store.listProviders() {
            if let plan = try await store.getPlan(providerId: p.id) {
                map[p.id] = plan
            }
        }
        return map
    }

    // MARK: - CRUD

    /// Add from fleet catalog (poll key and/or subscription).
    public func addFromCatalog(
        entry: LocalProviderCatalogEntry,
        displayName: String?,
        apiKey: String?,
        monthlyBudgetUsd: Double?,
        subscriptionCostUsd: Double?,
        subscriptionName: String?
    ) async throws {
        let name = entry.name
        let existing = try await store.listProviders()
        if existing.contains(where: { $0.name == name }) {
            throw LocalWriteError.conflict("Provider '\(entry.displayName)' is already added.")
        }

        let trimmedKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let needsKey = entry.mode == .poll || (entry.mode == .keyPlusSubscription && !trimmedKey.isEmpty)
        if entry.mode == .poll && trimmedKey.isEmpty {
            throw LocalWriteError.validation("API key required for \(entry.displayName)")
        }

        var keychainAccountId: String?
        if needsKey && !trimmedKey.isEmpty {
            let accountId = UUID().uuidString
            try secrets.save(accountId: accountId, credentials: ProviderCredentials(apiKey: trimmedKey))
            keychainAccountId = accountId
        }

        let adapterKind: String = {
            switch entry.mode {
            case .poll: return entry.adapterKind
            case .subscription: return "subscription_only"
            case .keyPlusSubscription:
                // Key stored for future poll ports; spend via subscription if set.
                return entry.adapterKind == "subscription_only" ? "subscription_only" : entry.adapterKind
            }
        }()

        // Poll adapters available on phone today.
        let supportedPoll = Set(["openrouter", "deepseek", "openai", "anthropic", "hetzner"])
        let resolvedKind: String = {
            if adapterKind == "subscription_only" { return adapterKind }
            if supportedPoll.contains(adapterKind) { return adapterKind }
            return "subscription_only"
        }()

        var p = LocalProvider(
            name: name,
            displayName: (displayName?.isEmpty == false ? displayName! : entry.displayName),
            adapterKind: resolvedKind,
            category: entry.category,
            keychainAccountId: keychainAccountId
        )
        p.updatedAt = Date()
        try await store.upsertProvider(p)
        var plan = LocalProviderPlan(providerId: p.id, monthlyBudgetUsd: monthlyBudgetUsd)
        plan.updatedAt = Date()
        try await store.upsertPlan(plan)

        // Catalog `suggestedMonthlyUsd` is UI prefill only. Never fall back to it
        // here — seed used to invent fake MTD charges (Vercel Pro $20, Workers $5,
        // Robinhood Gold $5). Only an explicit cost from Add → Save creates a sub.
        if let explicitCost = subscriptionCostUsd {
            try await attachSubscription(
                providerId: p.id,
                name: subscriptionName
                    ?? entry.suggestedSubscriptionName
                    ?? "\(entry.displayName) plan",
                costUsd: max(0, explicitCost)
            )
        }

        try await reload()
    }

    /// Insert every catalog provider not already present as **inactive $0 shells**.
    /// Never attaches subscriptions or invents spend — catalog price hints are
    /// for the Add form only.
    @discardableResult
    public func seedMissingCatalogProviders() async throws -> Int {
        let existing = Set(try await store.listProviders().map(\.name))
        var added = 0
        for entry in LocalProviderCatalog.all {
            if existing.contains(entry.name) { continue }
            var p = LocalProvider(
                name: entry.name,
                displayName: entry.displayName,
                adapterKind: "subscription_only",
                category: entry.category,
                isActive: false
            )
            p.updatedAt = Date()
            try await store.upsertProvider(p)
            try await store.upsertPlan(LocalProviderPlan(providerId: p.id))
            added += 1
        }
        return added
    }

    /// Historical seed ghosts only (pre-fix catalog auto-charged these).
    private static let seedGhostSignatures: [(providerName: String, costUsd: Double, subNames: Set<String>)] = [
        ("cloudflare", 5, ["Workers Paid"]),
        ("vercel", 20, ["Vercel Pro"]),
        ("robinhood", 5, ["Robinhood Gold"]),
    ]

    /// Cancel known seed-invented subscriptions and delete their charges so
    /// Overview MTD stops counting fees the owner never paid.
    @discardableResult
    public func scrubCatalogGuessCharges(reloadAfter: Bool = true) async throws -> Int {
        let providers = try await store.listProviders()
        let byProviderName = Dictionary(uniqueKeysWithValues: providers.map { ($0.name, $0) })
        var scrubbed = 0
        for ghost in Self.seedGhostSignatures {
            guard let p = byProviderName[ghost.providerName] else { continue }
            let subs = try await store.listSubscriptions().filter { $0.providerId == p.id }
            for var sub in subs {
                guard sub.status == "active",
                      abs(sub.costUsd - ghost.costUsd) < 0.005,
                      ghost.subNames.contains(sub.name)
                else { continue }
                sub.status = "canceled"
                sub.updatedAt = Date()
                try await store.upsertSubscription(sub)
                try await store.deleteCharges(subscriptionId: sub.id)
                scrubbed += 1
            }
        }
        if reloadAfter { try await reload() }
        return scrubbed
    }

    public func addOpenRouterProvider(
        name: String,
        displayName: String,
        apiKey: String,
        monthlyBudgetUsd: Double?
    ) async throws {
        guard let entry = LocalProviderCatalog.entry(name: "openrouter") else { return }
        try await addFromCatalog(
            entry: entry,
            displayName: displayName,
            apiKey: apiKey,
            monthlyBudgetUsd: monthlyBudgetUsd,
            subscriptionCostUsd: nil,
            subscriptionName: nil
        )
    }

    public func addSubscriptionOnlyProvider(
        name: String,
        displayName: String,
        subscriptionName: String,
        costUsd: Double
    ) async throws {
        let entry = LocalProviderCatalogEntry(
            name: name,
            displayName: displayName,
            category: "Other",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "",
            suggestedMonthlyUsd: costUsd,
            suggestedSubscriptionName: subscriptionName
        )
        try await addFromCatalog(
            entry: entry,
            displayName: displayName,
            apiKey: nil,
            monthlyBudgetUsd: nil,
            subscriptionCostUsd: costUsd,
            subscriptionName: subscriptionName
        )
    }

    private func attachSubscription(providerId: String, name: String, costUsd: Double) async throws {
        let periodStart = BudgetEngine.utcMonthStart()
        let next = SubscriptionPeriodMath.advancePeriod(
            periodStart: periodStart,
            interval: "monthly",
            intervalCount: 1
        )
        let sub = LocalSubscription(
            providerId: providerId,
            name: name,
            costUsd: costUsd,
            startDate: periodStart,
            currentPeriodStart: periodStart,
            nextRenewalAt: next,
            status: costUsd > 0 ? "active" : "considering"
        )
        try await store.upsertSubscription(sub)
        if costUsd > 0 {
            _ = try await SubscriptionMaterializer.materialize(store: store)
        }
    }

    public func setBudget(providerId: String, monthlyBudgetUsd: Double?) async throws {
        var plan = try await store.getPlan(providerId: providerId) ?? LocalProviderPlan(providerId: providerId)
        plan.monthlyBudgetUsd = monthlyBudgetUsd
        plan.updatedAt = Date()
        try await store.upsertPlan(plan)
        try await reload()
    }

    public func setActive(providerId: String, isActive: Bool) async throws {
        guard var p = try await store.getProvider(id: providerId) else { return }
        p.isActive = isActive
        p.updatedAt = Date()
        try await store.upsertProvider(p)
        try await reload()
    }

    /// Create or update the first active/considering/paused subscription for a provider.
    public func setRecurringFee(providerId: String, name: String, costUsd: Double) async throws {
        let existing = try await store.listSubscriptions().filter { $0.providerId == providerId }
        if var sub = existing.first(where: {
            $0.status == "active" || $0.status == "considering" || $0.status == "paused"
        }) {
            sub.name = name
            sub.costUsd = max(0, costUsd)
            sub.status = costUsd > 0 ? "active" : "considering"
            sub.updatedAt = Date()
            try await store.upsertSubscription(sub)
            if costUsd > 0 {
                _ = try await SubscriptionMaterializer.materialize(store: store)
            }
        } else {
            try await attachSubscription(providerId: providerId, name: name, costUsd: max(0, costUsd))
        }
        try await reload()
    }

    public func cancelRecurringFees(providerId: String) async throws {
        let subs = try await store.listSubscriptions().filter { $0.providerId == providerId }
        for var sub in subs where sub.status == "active" || sub.status == "considering" {
            sub.status = "canceled"
            sub.updatedAt = Date()
            try await store.upsertSubscription(sub)
        }
        try await reload()
    }

    // MARK: - Projects

    public func upsertProject(name: String, description: String?, monthlyBudgetUsd: Double?, id: String? = nil) async throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalWriteError.validation("Project name required") }
        let now = Date()
        if let id, var existing = projects.first(where: { $0.id == id }) {
            existing.name = trimmed
            existing.nameKey = trimmed.lowercased()
            existing.description = description
            existing.monthlyBudgetUsd = monthlyBudgetUsd
            existing.updatedAt = now
            try await store.upsertProject(existing)
        } else {
            var p = LocalProject(name: trimmed, description: description, monthlyBudgetUsd: monthlyBudgetUsd)
            p.updatedAt = now
            try await store.upsertProject(p)
        }
        try await reload()
    }

    public func deleteProject(id: String) async throws {
        try await store.deleteProject(id: id)
        try await reload()
    }

    /// Direct spend attributed to a project (subscription charges with projectId).
    public func projectSpentUsd(projectId: String) async throws -> Double {
        let charges = try await store.allCharges().filter { $0.projectId == projectId }
        let monthStart = BudgetEngine.utcMonthStart()
        return charges
            .filter { $0.periodStart >= monthStart }
            .reduce(0) { $0 + $1.costUsd }
    }

    // MARK: - Snapshots

    public func snapshots(for providerId: String, limit: Int = 60) async throws -> [LocalUsageSnapshot] {
        try await store.listSnapshots(providerId: providerId, limit: limit)
    }

    // MARK: - Export (no secrets)

    public func exportPackageJSON() async throws -> Data {
        try await LocalExportBuilder.build(store: store)
    }

    public func deleteProvider(id: String) async throws {
        if let p = try await store.getProvider(id: id), let acc = p.keychainAccountId {
            try secrets.delete(accountId: acc)
        }
        try await store.deleteProvider(id: id)
        try await reload()
    }

    public func wipeAll() async throws {
        for p in try await store.listProviders() {
            if let acc = p.keychainAccountId {
                try? secrets.delete(accountId: acc)
            }
        }
        try await store.wipeAll()
        try await reload()
    }

    // MARK: - Poll

    public func refreshAllDue(force: Bool = false) async {
        isRefreshing = true
        lastError = nil
        defer { isRefreshing = false }
        do {
            _ = try await SubscriptionMaterializer.materialize(store: store)
            let list = try await store.listProviders().filter { $0.isActive && $0.isPollable }
            for p in list {
                if !force, let last = p.lastFetchAt {
                    let due = last.addingTimeInterval(Double(p.refreshIntervalMin) * 60)
                    if due > Date() { continue }
                }
                await poll(provider: p)
            }
            try await reload()
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func poll(providerId: String) async {
        isRefreshing = true
        defer { isRefreshing = false }
        guard let p = try? await store.getProvider(id: providerId) else { return }
        await poll(provider: p)
        try? await reload()
    }

    private func poll(provider: LocalProvider) async {
        guard provider.isPollable else { return }
        guard let accountId = provider.keychainAccountId,
              let creds = try? secrets.load(accountId: accountId) else {
            try? await store.setProviderFetchResult(
                id: provider.id,
                at: Date(),
                error: "Missing API key in Keychain"
            )
            return
        }
        do {
            let adapter = adapter(for: provider.adapterKind)
            let result = try await adapter.fetchUsage(credentials: creds)
            let snap = LocalUsageSnapshot(
                providerId: provider.id,
                fetchedAt: result.fetchedAt,
                balance: result.balance,
                totalCost: result.totalCost,
                fixedCostIncludedUsd: result.fixedCostIncludedUsd,
                costWindowStart: result.costWindowStart,
                costWindowEnd: result.costWindowEnd,
                costScope: result.costScope.rawValue,
                costIncludesUnknownFixed: result.costIncludesUnknownFixed,
                totalRequests: result.totalRequests,
                credits: result.credits,
                costCoverageCaveatCode: result.costCoverageCaveat?.code,
                costCoverageCaveatMessage: result.costCoverageCaveat?.message
            )
            try await store.insertSnapshot(snap)
            try await store.setProviderFetchResult(
                id: provider.id,
                at: result.fetchedAt,
                error: result.statusNote
            )
        } catch let e as AdapterRunError {
            try? await store.setProviderFetchResult(id: provider.id, at: Date(), error: e.message)
        } catch {
            try? await store.setProviderFetchResult(
                id: provider.id,
                at: Date(),
                error: error.localizedDescription
            )
        }
    }

    private func adapter(for kind: String) -> any ProviderAdapter {
        LocalAdapterRegistry.adapter(for: kind)
    }
}
