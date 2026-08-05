import SwiftUI
import DesignSystem
import LocalAdapters
import LocalBudget
import LocalStore

/// Full shell for **Local Usage Monitor** (Milestone A).
public struct LocalRootView: View {
    @State private var model = LocalAppModel()
    @State private var tab: Tab = .overview
    @State private var showAddProvider = false

    public init() {}

    public enum Tab: String, CaseIterable, Identifiable {
        case overview, providers, settings
        public var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return "Overview"
            case .providers: return "Providers"
            case .settings: return "Settings"
            }
        }
        var systemImage: String {
            switch self {
            case .overview: return "chart.pie.fill"
            case .providers: return "server.rack"
            case .settings: return "gearshape.fill"
            }
        }
    }

    public var body: some View {
        TabView(selection: $tab) {
            overviewTab
                .tabItem { Label(Tab.overview.title, systemImage: Tab.overview.systemImage) }
                .tag(Tab.overview)
            providersTab
                .tabItem { Label(Tab.providers.title, systemImage: Tab.providers.systemImage) }
                .tag(Tab.providers)
            settingsTab
                .tabItem { Label(Tab.settings.title, systemImage: Tab.settings.systemImage) }
                .tag(Tab.settings)
        }
        .tint(Theme.Colors.accent)
        .task { await model.bootstrap() }
        .sheet(isPresented: $showAddProvider) {
            AddProviderSheet(model: model)
        }
    }

    // MARK: - Overview

    private var overviewTab: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    // Always-visible product identity (home-screen: "Local Usage Monitor").
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "iphone")
                            .font(.system(size: 14, weight: .semibold))
                        Text("ON-DEVICE · no server")
                            .font(Theme.Typography.captionEmphasis)
                        Spacer()
                        Text("Local")
                            .font(Theme.Typography.captionEmphasis)
                    }
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(Color(red: 0.05, green: 0.72, blue: 0.68), in: RoundedRectangle(cornerRadius: Theme.Radius.md))

                    if let err = model.lastError {
                        Text(err)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.danger)
                            .dsCard()
                    }
                    if let s = model.summary {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text("Month to date")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                            Text(formatUSD(s.totalSpentUsd))
                                .font(Theme.Typography.hero)
                                .foregroundStyle(Theme.Colors.primaryText)
                            if let budget = s.totalBudgetUsd {
                                Text("of \(formatUSD(budget)) budgeted")
                                    .font(Theme.Typography.callout)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            } else {
                                Text("No budgets set — add providers and budgets in Providers")
                                    .font(Theme.Typography.callout)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                            if s.overBudget {
                                Text("Over budget")
                                    .font(Theme.Typography.captionEmphasis)
                                    .foregroundStyle(Theme.Colors.danger)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .dsCard()

                        ForEach(s.providers, id: \.providerId) { row in
                            providerSpendRow(row)
                        }
                    } else if !model.isReady {
                        ProgressView("Opening local store…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        EmptyState(
                            systemImage: "iphone",
                            title: "No providers yet",
                            message: "Add OpenRouter (Management key) or a subscription-only provider.",
                            actionTitle: "Add provider"
                        ) { showAddProvider = true }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .dsScreenBackground()
            .navigationTitle("Local Usage Monitor")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refreshAllDue(force: true) }
                    } label: {
                        if model.isRefreshing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
            }
            .refreshable { await model.refreshAllDue(force: true) }
        }
    }

    private func providerSpendRow(_ row: BudgetEngine.ProviderSpend) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack {
                Text(row.displayName)
                    .font(Theme.Typography.callout.weight(.semibold))
                Spacer()
                Text(formatUSD(row.spentUsd))
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(color(for: row.level))
            }
            if let budget = row.monthlyBudgetUsd, budget > 0 {
                ProgressView(value: min(row.spentUsd / budget, 1.2), total: 1)
                    .tint(color(for: row.level))
            }
            Text(detailLine(row))
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .dsCard(padding: Theme.Spacing.md)
    }

    private func detailLine(_ row: BudgetEngine.ProviderSpend) -> String {
        var parts = [
            "poll \(formatUSD(row.pollVariableUsd))",
            "subs \(formatUSD(row.subscriptionChargesUsd))",
            "fixed \(formatUSD(row.planFixedUsd))",
        ]
        if let err = row.lastFetchError { parts.append(err) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Providers

    private var providersTab: some View {
        NavigationStack {
            List {
                ForEach(model.providers) { p in
                    NavigationLink {
                        ProviderDetailView(model: model, providerId: p.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(p.displayName)
                            Text(p.adapterKind + (p.isActive ? "" : " · inactive"))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    }
                }
                .onDelete { indexSet in
                    Task {
                        for i in indexSet {
                            try? await model.deleteProvider(id: model.providers[i].id)
                        }
                    }
                }
            }
            .navigationTitle("Providers")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAddProvider = true } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
    }

    // MARK: - Settings

    private var settingsTab: some View {
        NavigationStack {
            List {
                Section("This app") {
                    LabeledContent("Product", value: "On-device self-host")
                    LabeledContent("Schema", value: "v\(model.schemaVersion)")
                    LabeledContent("Providers", value: "\(model.providers.count)")
                    Text("Money-truth is local SQLite. Provider API keys stay in Keychain. No remote Usage Monitor server required.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section("Also in this project") {
                    Text("**Usage Monitor** (other app) is the live-sync client for a self-hosted or owner server — use that if you run a VPS like the fleet.")
                        .font(Theme.Typography.caption)
                }
                Section("Catalog") {
                    Text("\(LocalProviderCatalog.all.count) fleet providers available under + Add.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Seed missing fleet templates") {
                        Task {
                            _ = try? await model.seedMissingCatalogProviders()
                            try? await model.reload()
                        }
                    }
                }
                Section("Data") {
                    Button("Refresh all providers", role: nil) {
                        Task { await model.refreshAllDue(force: true) }
                    }
                    Button("Wipe all local data", role: .destructive) {
                        Task { try? await model.wipeAll() }
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func color(for level: BudgetEngine.SpendLevel) -> Color {
        switch level {
        case .ok: return Theme.Colors.success
        case .warning: return Theme.Colors.warning
        case .exceeded: return Theme.Colors.danger
        case .unconfigured: return Theme.Colors.secondaryText
        }
    }

    private func formatUSD(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f.string(from: NSNumber(value: v)) ?? String(format: "$%.2f", v)
    }
}

// MARK: - Add provider

private struct AddProviderSheet: View {
    @Bindable var model: LocalAppModel
    @Environment(\.dismiss) private var dismiss

    @State private var search = ""
    @State private var selected: LocalProviderCatalogEntry?
    @State private var displayName = ""
    @State private var apiKey = ""
    @State private var budgetText = ""
    @State private var subCostText = ""
    @State private var error: String?
    @State private var seedMessage: String?

    private var filtered: [LocalProviderCatalogEntry] {
        LocalProviderCatalog.filtered(search: search)
    }

    private var grouped: [(String, [LocalProviderCatalogEntry])] {
        Dictionary(grouping: filtered, by: \.category)
            .map { ($0.key, $0.value.sorted { $0.displayName < $1.displayName }) }
            .sorted { $0.0 < $1.0 }
    }

    var body: some View {
        NavigationStack {
            Form {
                if selected == nil {
                    Section {
                        TextField("Search providers", text: $search)
                        Button("Seed all fleet templates (no API keys)") {
                            Task { await seed() }
                        }
                        Text("Adds subscription/manual shells for every catalog provider that does not need a key on first save. Pollable LLMs (OpenRouter, OpenAI, …) still need a key via Add.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let seedMessage {
                            Text(seedMessage).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(grouped, id: \.0) { category, entries in
                        Section(category) {
                            ForEach(entries) { entry in
                                Button {
                                    selected = entry
                                    displayName = entry.displayName
                                    subCostText = entry.suggestedMonthlyUsd.map { String(format: "%g", $0) } ?? ""
                                    apiKey = ""
                                    budgetText = ""
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(entry.displayName)
                                                .foregroundStyle(.primary)
                                            Text(modeLabel(entry.mode))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                    }
                } else if let entry = selected {
                    Section(entry.displayName) {
                        Text(entry.help)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("Display name", text: $displayName)
                        if entry.mode == .poll || entry.mode == .keyPlusSubscription {
                            SecureField(entry.keyFieldLabel, text: $apiKey)
                            TextField("Monthly budget USD (optional)", text: $budgetText)
                                .keyboardType(.decimalPad)
                        }
                        if entry.mode == .subscription || entry.mode == .keyPlusSubscription {
                            TextField("Monthly subscription USD", text: $subCostText)
                                .keyboardType(.decimalPad)
                        }
                    }
                    if let error {
                        Section { Text(error).foregroundStyle(.red).font(.caption) }
                    }
                }
            }
            .navigationTitle(selected == nil ? "Add provider" : "Configure")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(selected == nil ? "Cancel" : "Back") {
                        if selected != nil {
                            selected = nil
                            error = nil
                        } else {
                            dismiss()
                        }
                    }
                }
                if selected != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { await save() } }
                    }
                }
            }
        }
    }

    private func modeLabel(_ mode: LocalProviderMode) -> String {
        switch mode {
        case .poll: return "API poll (cost/balance)"
        case .subscription: return "Subscription / manual"
        case .keyPlusSubscription: return "Key optional · track subscription"
        }
    }

    private func seed() async {
        error = nil
        do {
            let n = try await model.seedMissingCatalogProviders()
            seedMessage = n == 0 ? "Catalog already fully seeded." : "Added \(n) providers."
            try? await model.reload()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        error = nil
        guard let entry = selected else { return }
        do {
            try await model.addFromCatalog(
                entry: entry,
                displayName: displayName,
                apiKey: apiKey.isEmpty ? nil : apiKey,
                monthlyBudgetUsd: Double(budgetText),
                subscriptionCostUsd: Double(subCostText),
                subscriptionName: entry.suggestedSubscriptionName
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Detail

private struct ProviderDetailView: View {
    @Bindable var model: LocalAppModel
    let providerId: String

    private var provider: LocalProvider? {
        model.providers.first { $0.id == providerId }
    }

    private var spend: BudgetEngine.ProviderSpend? {
        model.summary?.providers.first { $0.providerId == providerId }
    }

    var body: some View {
        List {
            if let p = provider {
                Section("Provider") {
                    LabeledContent("Name", value: p.displayName)
                    LabeledContent("Adapter", value: p.adapterKind)
                    if let last = p.lastFetchAt {
                        LabeledContent("Last fetch", value: last.formatted())
                    }
                    if let err = p.lastFetchError {
                        Text(err).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let s = spend {
                Section("Spend (MTD)") {
                    LabeledContent("Total", value: String(format: "$%.2f", s.spentUsd))
                    LabeledContent("Poll variable", value: String(format: "$%.2f", s.pollVariableUsd))
                    LabeledContent("Subscriptions", value: String(format: "$%.2f", s.subscriptionChargesUsd))
                    LabeledContent("Plan fixed", value: String(format: "$%.2f", s.planFixedUsd))
                    if let b = s.monthlyBudgetUsd {
                        LabeledContent("Budget", value: String(format: "$%.2f", b))
                    }
                }
            }
            Section {
                Button("Fetch now") {
                    Task { await model.poll(providerId: providerId) }
                }
            }
        }
        .navigationTitle(provider?.displayName ?? "Provider")
    }
}
