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
        let plans = try await loadPlans()
        let snaps = try await store.allSnapshots()
        let charges = try await store.allCharges()
        summary = BudgetEngine.compute(
            providers: providers,
            plans: plans,
            snapshots: snaps,
            subscriptions: subscriptions,
            charges: charges
        )
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
        let supportedPoll = Set(["openrouter", "deepseek", "openai", "anthropic"])
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

        let subCost = subscriptionCostUsd ?? 0
        if entry.mode != .poll || subCost > 0 {
            if subCost > 0 || entry.mode == .subscription {
                let cost = max(0, subscriptionCostUsd ?? entry.suggestedMonthlyUsd ?? 0)
                if cost > 0 || entry.mode == .subscription {
                    try await attachSubscription(
                        providerId: p.id,
                        name: subscriptionName
                            ?? entry.suggestedSubscriptionName
                            ?? "\(entry.displayName) plan",
                        costUsd: cost
                    )
                }
            }
        }

        try await reload()
    }

    /// Insert every catalog provider not already present (subscription shells / empty poll rows).
    @discardableResult
    public func seedMissingCatalogProviders() async throws -> Int {
        let existing = Set(try await store.listProviders().map(\.name))
        var added = 0
        for entry in LocalProviderCatalog.all {
            if existing.contains(entry.name) { continue }
            // Skip pure poll entries that require a key (user adds those with credentials).
            if entry.mode == .poll { continue }
            try await addFromCatalog(
                entry: entry,
                displayName: entry.displayName,
                apiKey: nil,
                monthlyBudgetUsd: nil,
                subscriptionCostUsd: entry.suggestedMonthlyUsd,
                subscriptionName: entry.suggestedSubscriptionName
            )
            added += 1
        }
        return added
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
