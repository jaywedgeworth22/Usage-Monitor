import SwiftUI
import DesignSystem
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

    enum Kind: String, CaseIterable {
        case openrouter = "OpenRouter (poll)"
        case claudeSub = "Claude subscription (manual)"
    }

    @State private var kind: Kind = .openrouter
    @State private var displayName = "OpenRouter"
    @State private var apiKey = ""
    @State private var budgetText = ""
    @State private var subCostText = "200"
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $kind) {
                    ForEach(Kind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                TextField("Display name", text: $displayName)
                if kind == .openrouter {
                    SecureField("Management API key", text: $apiKey)
                    TextField("Monthly budget USD (optional)", text: $budgetText)
                        .keyboardType(.decimalPad)
                    Text("Use an OpenRouter **Management** key for month-to-date spend. Inference-only keys connect but report $0 poll spend.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    TextField("Monthly cost USD", text: $subCostText)
                        .keyboardType(.decimalPad)
                    Text("Anthropic personal / Claude Max etc. cannot be polled without Admin org keys — track as a subscription.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.caption)
                }
            }
            .navigationTitle("Add provider")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                }
            }
        }
    }

    private func save() async {
        error = nil
        do {
            switch kind {
            case .openrouter:
                let budget = Double(budgetText)
                try await model.addOpenRouterProvider(
                    name: "openrouter",
                    displayName: displayName.isEmpty ? "OpenRouter" : displayName,
                    apiKey: apiKey,
                    monthlyBudgetUsd: budget
                )
            case .claudeSub:
                let cost = Double(subCostText) ?? 0
                try await model.addSubscriptionOnlyProvider(
                    name: "anthropic-claude",
                    displayName: displayName.isEmpty ? "Claude" : displayName,
                    subscriptionName: "Claude plan",
                    costUsd: cost
                )
            }
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
