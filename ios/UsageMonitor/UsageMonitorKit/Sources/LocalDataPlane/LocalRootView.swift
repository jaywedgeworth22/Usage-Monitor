import SwiftUI
import DesignSystem
import LocalAdapters
import LocalBudget
import LocalStore
import AppCore

/// Full shell for **Local Usage Monitor** — on-device money-truth that aims to
/// match and exceed web/remote for personal poll + subscription tracking.
public struct LocalRootView: View {
    @Bindable var settings: AppSettings
    @State private var model = LocalAppModel()
    @State private var tab: Tab = .overview
    @State private var showAddProvider = false
    @State private var pendingDeleteProvider: LocalProvider?
    @State private var showWipeConfirmation = false
    @State private var pathProviders = NavigationPath()

    /// Caller must supply a main-actor `AppSettings` (e.g. `@State` from the app
    /// entry). No default `AppSettings()` here — its `@MainActor` init cannot run
    /// as a nonisolated default argument expression.
    public init(settings: AppSettings) {
        self.settings = settings
    }

    public enum Tab: String, CaseIterable, Identifiable {
        case overview, providers, projects, alerts, settings
        public var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return "Overview"
            case .providers: return "Providers"
            case .projects: return "Projects"
            case .alerts: return "Alerts"
            case .settings: return "Settings"
            }
        }
        var systemImage: String {
            switch self {
            case .overview: return "chart.pie.fill"
            case .providers: return "server.rack"
            case .projects: return "folder.fill"
            case .alerts: return "bell.badge.fill"
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
            LocalProjectsTab(model: model)
                .tabItem { Label(Tab.projects.title, systemImage: Tab.projects.systemImage) }
                .tag(Tab.projects)
            LocalAlertsTab(model: model) { providerId in
                tab = .providers
                pathProviders.append(providerId)
            }
            .tabItem { Label(Tab.alerts.title, systemImage: Tab.alerts.systemImage) }
            .tag(Tab.alerts)
            .badge(model.alerts.isEmpty ? 0 : model.alerts.count)
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
                    if let s = model.summary, !s.providers.isEmpty {
                        LocalOverviewContent(
                            summary: s,
                            alertCount: model.alerts.count,
                            onOpenProvider: { id in
                                tab = .providers
                                pathProviders.append(id)
                            },
                            onOpenAlerts: { tab = .alerts },
                            onAddProvider: { showAddProvider = true }
                        )
                        if !model.subscriptions.filter({ $0.status == "active" && $0.costUsd > 0 }).isEmpty {
                            LocalRecurringFeesCard(
                                subscriptions: model.subscriptions,
                                providers: model.providers
                            )
                        }
                    } else if !model.isReady {
                        ProgressView("Opening local store…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        EmptyState(
                            systemImage: "iphone",
                            title: "No Providers Yet",
                            message: "Add OpenRouter (Management key) or a subscription-only provider — same money model as the web (poll + fees).",
                            actionTitle: "Add Provider"
                        ) { showAddProvider = true }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .dsScreenBackground()
            .navigationTitle("Overview")
            .navigationBarTitleDisplayMode(.inline)
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
                    .accessibilityLabel("Refresh")
                }
            }
            .refreshable { await model.refreshAllDue(force: true) }
        }
    }

    // MARK: - Providers

    private var providersTab: some View {
        NavigationStack(path: $pathProviders) {
            LocalProvidersListContent(
                model: model,
                onAdd: { showAddProvider = true },
                onRequestDelete: { pendingDeleteProvider = $0 }
            )
            .navigationTitle("Providers")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                ProviderDetailView(model: model, providerId: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAddProvider = true } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add Provider")
                }
            }
            .confirmationDialog(
                "Delete this provider?",
                isPresented: Binding(
                    get: { pendingDeleteProvider != nil },
                    set: { if !$0 { pendingDeleteProvider = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDeleteProvider
            ) { provider in
                Button("Delete \(provider.displayName)", role: .destructive) {
                    Task {
                        try? await model.deleteProvider(id: provider.id)
                        pendingDeleteProvider = nil
                    }
                }
                Button("Cancel", role: .cancel) {
                    pendingDeleteProvider = nil
                }
            } message: { provider in
                Text("“\(provider.displayName)” and its Keychain credentials will be removed from this phone.")
            }
        }
    }

    // MARK: - Settings

    private var settingsTab: some View {
        NavigationStack {
            List {
                Section("This App") {
                    LabeledContent("Product", value: "on-device self-host")
                    LabeledContent("Schema", value: "v\(model.schemaVersion)")
                    LabeledContent("Providers", value: "\(model.providers.count)")
                    LabeledContent("Subscriptions", value: "\(model.subscriptions.filter { $0.status == "active" }.count) active")
                    Text("Money-truth is local SQLite. Provider API keys stay in Keychain. No remote Usage Monitor server required.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section("Subscriptions") {
                    let active = model.subscriptions.filter { $0.status == "active" && $0.costUsd > 0 }
                    if active.isEmpty {
                        Text("no active recurring fees")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    } else {
                        ForEach(active.sorted { $0.costUsd > $1.costUsd }) { sub in
                            LabeledContent(sub.name, value: CurrencyFormat.usd(sub.costUsd))
                        }
                        LabeledContent(
                            "Monthly Run-Rate",
                            value: CurrencyFormat.usd(active.reduce(0) { $0 + $1.costUsd })
                        )
                    }
                    Text("Edit fees on each provider detail (Recurring Fee). Materializer posts one charge per billing period into MTD spend.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section("Appearance") {
                    Picker("Theme", selection: $settings.theme) {
                        ForEach(AppTheme.allCases) { theme in
                            Text(theme.label).tag(theme)
                        }
                    }
                }
                Section("Security") {
                    Toggle("Require Face ID / Passcode", isOn: $settings.appLockEnabled)
                        .tint(Theme.Colors.accent)
                }
                Section("Backup") {
                    LocalExportButton(model: model)
                    LocalImportButton(model: model)
                    Text("Export/import providers, plans, fees, charges, and snapshots as JSON. Never includes API keys — re-enter keys after import.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Also in This Project") {
                    Text("**Usage Monitor** (other app) is the live-sync client for a self-hosted or owner server — use that if you run a VPS like the fleet.")
                        .font(Theme.Typography.caption)
                }
                Section("Providers Catalog") {
                    Text("\(LocalProviderCatalog.all.count) known services. “Add Missing Providers” creates inactive empty cards (no fees, no keys) so you can fill them in. Safe to re-run; data stays on this phone across app updates.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Add Missing Providers") {
                        Task {
                            _ = try? await model.ensureCatalogProviders()
                        }
                    }
                    Button("Remove Incorrect Catalog Fees") {
                        Task { _ = try? await model.scrubCatalogGuessCharges() }
                    }
                }
                Section("Data") {
                    Button("Refresh All Providers", role: nil) {
                        Task { await model.refreshAllDue(force: true) }
                    }
                    Button("Wipe All Local Data", role: .destructive) {
                        showWipeConfirmation = true
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Wipe All Local Data?",
                isPresented: $showWipeConfirmation,
                titleVisibility: .visible
            ) {
                Button("Wipe Everything", role: .destructive) {
                    Task { try? await model.wipeAll() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes every provider, plan, subscription charge, and Keychain API key on this phone.")
            }
        }
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
    @State private var teamId = ""
    @State private var accountSid = ""
    @State private var apiKeySid = ""
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
                        Button("Add Missing Providers") {
                            Task { await seed() }
                        }
                        Text("Creates empty cards for every known service that isn’t on this phone yet — no keys, no fees invented. Your data stays in the app’s private storage across updates.")
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
                                    teamId = ""
                                    accountSid = ""
                                    apiKeySid = ""
                                    budgetText = ""
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(entry.displayName)
                                                .foregroundStyle(.primary)
                                            Text(entry.connectionSummary)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(2)
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
                    Section {
                        Text(entry.help)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        FlowAbilityChips(abilities: entry.abilities)
                    } header: {
                        Text("What This Phone Can Do")
                    }
                    Section(entry.displayName) {
                        TextField("Display name", text: $displayName)
                        if entry.mode == .poll || entry.mode == .keyPlusSubscription {
                            SecureField(entry.keyFieldLabel, text: $apiKey)
                            if entry.requiresTeamId || entry.adapterKind == "xai" {
                                TextField("Team id (required for xAI)", text: $teamId)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            if entry.requiresAccountSid || entry.adapterKind == "twilio" {
                                TextField("Account SID (required)", text: $accountSid)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                TextField("API Key SID (optional)", text: $apiKeySid)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            TextField("Monthly budget USD (optional)", text: $budgetText)
                                .keyboardType(.decimalPad)
                        }
                        if entry.mode == .subscription || entry.mode == .keyPlusSubscription
                            || entry.mode == .poll {
                            TextField("Monthly fee USD (optional)", text: $subCostText)
                                .keyboardType(.decimalPad)
                        }
                    }
                    if let error {
                        Section { Text(error).foregroundStyle(.red).font(.caption) }
                    }
                }
            }
            .navigationTitle(selected == nil ? "Add Provider" : "Configure")
            .navigationBarTitleDisplayMode(.inline)
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

    private func seed() async {
        error = nil
        do {
            let n = try await model.ensureCatalogProviders()
            seedMessage = n == 0
                ? "All known services already have a card on this phone."
                : "Added \(n) provider card\(n == 1 ? "" : "s") (inactive, $0)."
            try? await model.reload()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        error = nil
        guard let entry = selected else { return }
        do {
            let fee = Double(subCostText)
            try await model.addFromCatalog(
                entry: entry,
                displayName: displayName,
                apiKey: apiKey.isEmpty ? nil : apiKey,
                monthlyBudgetUsd: Double(budgetText),
                subscriptionCostUsd: fee.flatMap { $0 > 0 ? $0 : nil },
                subscriptionName: entry.suggestedSubscriptionName,
                teamId: teamId.isEmpty ? nil : teamId,
                accountSid: accountSid.isEmpty ? nil : accountSid,
                apiKeySid: apiKeySid.isEmpty ? nil : apiKeySid
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Ability chips

private struct FlowAbilityChips: View {
    let abilities: [LocalConnectionAbility]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(abilities, id: \.self) { ability in
                HStack(alignment: .top, spacing: 8) {
                    Text(ability.chipLabel)
                        .font(Theme.Typography.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.Colors.accentSoft, in: Capsule())
                        .foregroundStyle(Theme.Colors.accent)
                    Text(ability.detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

// MARK: - Detail

private struct ProviderDetailView: View {
    @Bindable var model: LocalAppModel
    let providerId: String
    @State private var budgetText = ""
    @State private var feeText = ""
    @State private var feeName = ""
    @State private var showDeleteConfirm = false
    @State private var didSeedFields = false
    @State private var actionError: String?
    @State private var historyPoints: [Double] = []
    @State private var historyCaption: String?

    private var provider: LocalProvider? {
        model.providers.first { $0.id == providerId }
    }

    private var spend: BudgetEngine.ProviderSpend? {
        model.summary?.providers.first { $0.providerId == providerId }
    }

    var body: some View {
        List {
            if let p = provider {
                Section {
                    LabeledContent("Name", value: p.displayName)
                    if let entry = LocalProviderCatalog.entry(name: p.name) {
                        LabeledContent("Connection", value: entry.connectionSummary)
                        Text(entry.help)
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                        FlowAbilityChips(abilities: entry.abilities)
                    } else {
                        LabeledContent(
                            "Connection",
                            value: p.isPollable
                                ? (p.canFetch ? "polls when active" : "pollable · needs key")
                                : "recurring fee only"
                        )
                    }
                    Toggle("Active (poll / materialize)", isOn: Binding(
                        get: { p.isActive },
                        set: { next in
                            Task {
                                try? await model.setActive(providerId: providerId, isActive: next)
                            }
                        }
                    ))
                    if let last = p.lastFetchAt {
                        LabeledContent("Last Fetch", value: last.formatted())
                    }
                    if let err = p.lastFetchError, !err.isEmpty {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.warning)
                    }
                } header: {
                    Text("Provider")
                } footer: {
                    Text(p.isPollable
                         ? (p.canFetch
                            ? "Phone can poll this adapter when Active."
                            : "Poll adapter is available but no API key is stored — re-add with a key to fetch.")
                         : "No phone poll for this adapter. Enter a recurring fee below (like a subscription on the web).")
                }

                if let s = spend {
                    Section {
                        LabeledContent("Total", value: CurrencyFormat.usd(s.spentUsd))
                        LabeledContent("Poll Variable", value: CurrencyFormat.usd(s.pollVariableUsd))
                        LabeledContent("Subscriptions", value: CurrencyFormat.usd(s.subscriptionChargesUsd))
                        LabeledContent("Plan Fixed", value: CurrencyFormat.usd(s.planFixedUsd))
                        if let b = s.monthlyBudgetUsd {
                            LabeledContent("Budget", value: CurrencyFormat.usd(b))
                        } else {
                            LabeledContent("Budget", value: "no budget set")
                        }
                    } header: {
                        Text("Spend (MTD)")
                    } footer: {
                        Text("Poll totals are provider-reported (taxes/VAT often missing). Subscription fees are what you enter here — include tax yourself if you want the full bill.")
                    }

                    if let proj = s.projectedEomUsd, proj > 0.005 {
                        Section {
                            LabeledContent("Projected EOM", value: CurrencyFormat.usd(proj))
                            LabeledContent("Usage (Extrapolated)", value: CurrencyFormat.usd(s.pacedVariableUsd))
                            LabeledContent("Fixed Accrued MTD", value: CurrencyFormat.usd(s.fixedAccruedUsd))
                            LabeledContent("Known Renewals Remaining", value: CurrencyFormat.usd(s.remainingScheduledUsd))
                        } header: {
                            Text("EOM Projection Parts")
                        } footer: {
                            Text("Same composition as the web: paced variable usage + fixed accrued + known subscription renewals still due this UTC month.")
                        }
                    }
                }

                if historyPoints.count >= 2 {
                    Section {
                        SparklineCard(
                            title: "Poll history (total cost)",
                            value: historyCaption ?? "—",
                            caption: "\(historyPoints.count) samples",
                            points: historyPoints,
                            status: .neutral
                        )
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Snapshot history")
                    } footer: {
                        Text("On-device only — successive poll costs (not daily invoices).")
                    }
                }

                Section {
                    HStack {
                        Text("$")
                        TextField("No budget", text: $budgetText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Button("Save Budget") {
                        Task {
                            let trimmed = budgetText.trimmingCharacters(in: .whitespacesAndNewlines)
                            let value: Double? = trimmed.isEmpty ? nil : Double(trimmed)
                            do {
                                try await model.setBudget(providerId: providerId, monthlyBudgetUsd: value)
                                actionError = nil
                            } catch {
                                actionError = error.localizedDescription
                            }
                        }
                    }
                } header: {
                    Text("Monthly Budget")
                }

                Section {
                    TextField("Plan name", text: $feeName)
                    HStack {
                        Text("$")
                        TextField("0 = no charge", text: $feeText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Button("Save Recurring Fee") {
                        Task {
                            let cost = Double(feeText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                            let name = feeName.trimmingCharacters(in: .whitespacesAndNewlines)
                            do {
                                try await model.setRecurringFee(
                                    providerId: providerId,
                                    name: name.isEmpty ? "\(p.displayName) plan" : name,
                                    costUsd: cost
                                )
                                actionError = nil
                            } catch {
                                actionError = error.localizedDescription
                            }
                        }
                    }
                    Button("Cancel Recurring Fees", role: .destructive) {
                        Task {
                            try? await model.cancelRecurringFees(providerId: providerId)
                            feeText = ""
                        }
                    }
                } header: {
                    Text("Recurring Fee")
                } footer: {
                    Text("Use this for Max/Pro, Workers Paid, Vercel Pro, etc. Leave $0 if you do not pay for this product.")
                }

                if p.isPollable {
                    Section {
                        if p.canFetch {
                            Button {
                                Task { await model.poll(providerId: providerId) }
                            } label: {
                                if model.isRefreshing {
                                    ProgressView()
                                } else {
                                    Label("Fetch Now", systemImage: "arrow.triangle.2.circlepath")
                                }
                            }
                            .disabled(model.isRefreshing)
                        } else {
                            Label("Add an API key to enable Fetch", systemImage: "key")
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    } footer: {
                        Text(p.canFetch
                             ? "Pulls latest usage/cost from the provider API. Not an invoice."
                             : "Re-add this provider with a key, or track cost as a recurring fee above.")
                    }
                } else {
                    Section {
                        Label("No poll — subscription / push only", systemImage: "hand.raised")
                            .foregroundStyle(Theme.Colors.secondaryText)
                    } footer: {
                        Text("This provider cannot be fetched on the phone. Do not expect a Fetch button that only fails.")
                    }
                }

                Section {
                    Button("Delete Provider", role: .destructive) {
                        showDeleteConfirm = true
                    }
                }

                if let actionError {
                    Section("Error") {
                        Text(actionError).foregroundStyle(Theme.Colors.danger)
                    }
                }
            }
        }
        .navigationTitle(provider?.displayName ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            seedFieldsIfNeeded()
            await loadHistory()
        }
        .confirmationDialog(
            "Delete this provider?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task { try? await model.deleteProvider(id: providerId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes this connection, Keychain key, and local history for it.")
        }
    }

    private func seedFieldsIfNeeded() {
        guard !didSeedFields, let p = provider else { return }
        didSeedFields = true
        if let b = spend?.monthlyBudgetUsd {
            budgetText = b.formatted(.number.precision(.fractionLength(0...2)))
        }
        if let subUsd = spend?.subscriptionChargesUsd, subUsd > 0 {
            feeText = subUsd.formatted(.number.precision(.fractionLength(0...2)))
        }
        feeName = "\(p.displayName) plan"
    }

    private func loadHistory() async {
        guard let snaps = try? await model.snapshots(for: providerId, limit: 48) else {
            historyPoints = []
            return
        }
        // Oldest → newest for sparkline
        let ordered = snaps.reversed()
        let costs = ordered.compactMap(\.totalCost)
        historyPoints = costs
        if let last = costs.last {
            historyCaption = CurrencyFormat.usd(last)
        }
    }
}
