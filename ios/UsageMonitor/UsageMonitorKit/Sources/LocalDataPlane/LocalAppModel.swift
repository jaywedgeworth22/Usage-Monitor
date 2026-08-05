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

    public func addOpenRouterProvider(
        name: String,
        displayName: String,
        apiKey: String,
        monthlyBudgetUsd: Double?
    ) async throws {
        let accountId = UUID().uuidString
        try secrets.save(accountId: accountId, credentials: ProviderCredentials(apiKey: apiKey))
        var p = LocalProvider(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            adapterKind: "openrouter",
            keychainAccountId: accountId
        )
        p.updatedAt = Date()
        try await store.upsertProvider(p)
        var plan = LocalProviderPlan(providerId: p.id, monthlyBudgetUsd: monthlyBudgetUsd)
        plan.updatedAt = Date()
        try await store.upsertPlan(plan)
        try await reload()
    }

    public func addSubscriptionOnlyProvider(
        name: String,
        displayName: String,
        subscriptionName: String,
        costUsd: Double
    ) async throws {
        let p = LocalProvider(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            displayName: displayName,
            adapterKind: "subscription_only"
        )
        try await store.upsertProvider(p)
        try await store.upsertPlan(LocalProviderPlan(providerId: p.id))
        let periodStart = BudgetEngine.utcMonthStart()
        let next = SubscriptionPeriodMath.advancePeriod(
            periodStart: periodStart,
            interval: "monthly",
            intervalCount: 1
        )
        let sub = LocalSubscription(
            providerId: p.id,
            name: subscriptionName,
            costUsd: costUsd,
            startDate: periodStart,
            currentPeriodStart: periodStart,
            nextRenewalAt: next,
            status: "active"
        )
        try await store.upsertSubscription(sub)
        _ = try await SubscriptionMaterializer.materialize(store: store)
        try await reload()
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
        switch kind {
        case "openrouter": return OpenRouterAdapter()
        default: return UnsupportedAdapter(kind: kind)
        }
    }
}

private struct UnsupportedAdapter: ProviderAdapter {
    let kind: String
    var adapterKind: String { kind }
    func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        throw AdapterRunError.unsupported("Adapter '\(kind)' is not available in this build")
    }
}
