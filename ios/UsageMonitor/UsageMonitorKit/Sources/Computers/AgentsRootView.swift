import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Root of the **Agents** lane (tab `.agents`).
///
/// AI Coding Agent telemetry, live Mac process execution, 5-hour quota burn,
/// and PAYG API-equivalent cost comparison.
public struct AgentsRootView: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store: AgentsStore

    public init() {
        _store = State(initialValue: AgentsStore())
    }

    init(store: AgentsStore) {
        _store = State(initialValue: store)
    }

    public var body: some View {
        NavigationStack {
            List {
                windowSelector
                content
            }
            .listStyle(.insetGrouped)
            .tabBarScrollClearance()
            .navigationTitle("Coding Agents")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                guard let env else { return }
                await store.refresh(using: env.apiClient)
            }
        }
        .task(id: env?.accessIdentityRevision) {
            guard let env else { return }
            store.reset()
            await store.loadIfNeeded(using: env.apiClient)
        }
    }

    @ViewBuilder
    private var windowSelector: some View {
        Section {
            Picker("Window", selection: Binding(
                get: { store.window },
                set: { newWindow in
                    guard let env else { return }
                    Task { await store.setWindow(newWindow, using: env.apiClient) }
                }
            )) {
                Text("5h").tag("5h")
                Text("24h").tag("24h")
                Text("7d").tag("7d")
                Text("30d").tag("30d")
                Text("All").tag("all")
            }
            .pickerStyle(.segmented)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let data = store.state.value {
                loaded(data)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            Section {
                HStack {
                    SkeletonBlock(width: 120, height: 14)
                    Spacer()
                    SkeletonBlock(width: 60, height: 14)
                }
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(error.title)
                    .font(Theme.Typography.captionEmphasis)
                Text(error.message)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Button {
                    guard let env else { return }
                    Task { await store.refresh(using: env.apiClient) }
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise")
                        .font(Theme.Typography.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .tint(Theme.Colors.accent)
            }
        }
    }

    @ViewBuilder
    private func loaded(_ data: AgentsOverviewResponse) -> some View {
        summarySection(data)
        if data.burn5h.tokens5h > 0 {
            burnSection(data.burn5h)
        }
        platformsSection(data.platforms)
        if !data.modelDistribution.isEmpty {
            modelDistributionSection(data.modelDistribution)
        }
    }

    @ViewBuilder
    private func summarySection(_ data: AgentsOverviewResponse) -> some View {
        Section {
            LabeledContent("Active on Mac") {
                StatusBadge(
                    "\(data.summary.activeAgentCount)/\(data.summary.totalAgentCount) Active",
                    status: data.summary.activeAgentCount > 0 ? .ok : .neutral,
                    systemImage: "desktopcomputer"
                )
            }
            LabeledContent("Host Chip", value: data.macChip)
            LabeledContent("Total Tokens", value: formatTokens(data.summary.totalTokens))
            LabeledContent("PAYG Value", value: formatCurrency(data.summary.totalApiEquivalentCostUsd))
            LabeledContent("Net Savings") {
                Text("+\(formatCurrency(data.summary.totalNetSavingsUsd))")
                    .font(Theme.Typography.body.weight(.bold))
                    .foregroundStyle(Theme.Colors.success)
            }
        } header: {
            Text("Fleet Summary · \(data.windowLabel)")
        } footer: {
            Text("API Equivalent compares token volume with direct LiteLLM catalog list rates.")
        }
    }

    @ViewBuilder
    private func burnSection(_ burn: Burn5hSummary) -> some View {
        Section {
            LabeledContent("5h Token Burn", value: formatTokens(burn.tokens5h))
            LabeledContent("5h Cost Estimate", value: formatCurrency(burn.costEstimate5hUsd))
            LabeledContent("Token Burn Rate", value: "\(formatTokens(burn.burnRateTokensPerHour))/hr")
            LabeledContent("Spend Pace", value: "\(formatCurrency(burn.burnRateUsdPerHour))/hr")
        } header: {
            Text("5-Hour Rolling Activity")
        } footer: {
            Text("CCUsage 5-hour billing block activity pace.")
        }
    }

    @ViewBuilder
    private func platformsSection(_ platforms: [AgentPlatformStatus]) -> some View {
        Group {
            ForEach(platforms) { platform in
                Section {
                    LabeledContent("Status") {
                        StatusBadge(
                            platform.isRunningOnMac ? "Active on Mac" : "Idle on Mac",
                            status: platform.isRunningOnMac ? .ok : .neutral,
                            systemImage: platform.isRunningOnMac ? "checkmark.circle.fill" : "circle"
                        )
                    }
                    LabeledContent("Seat Cost", value: "$\(Int(platform.monthlySeatCostUsd))/mo")
                    LabeledContent("Tokens Processed", value: formatTokens(platform.totalTokens))
                    LabeledContent("PAYG Value", value: formatCurrency(platform.estimatedCostUsd))
                    LabeledContent("Net Savings") {
                        Text("+\(formatCurrency(platform.netSavingsUsd))")
                            .foregroundStyle(Theme.Colors.success)
                    }

                    if !platform.modelsUsed.isEmpty {
                        ForEach(platform.modelsUsed) { model in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(model.model)
                                        .font(Theme.Typography.captionEmphasis)
                                    Spacer()
                                    Text("\(formatTokens(model.tokens)) (\(Int(model.percentOfPlatform))%)")
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                                ProgressView(value: max(0.02, model.percentOfPlatform / 100))
                                    .tint(Theme.Colors.accent)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    HStack {
                        Text(platform.name)
                        Spacer()
                        Text(platform.provider)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } footer: {
                    Text("ℹ️ \(platform.dataCapability)")
                }
            }
        }
    }

    @ViewBuilder
    private func modelDistributionSection(_ distribution: [ModelDistributionItem]) -> some View {
        Section {
            ForEach(distribution) { item in
                LabeledContent(item.model) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(formatTokens(item.tokens)) (\(String(format: "%.1f", item.percent))%)")
                            .font(Theme.Typography.caption)
                        Text(formatCurrency(item.apiEquivalentCostUsd))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.success)
                    }
                }
            }
        } header: {
            Text("Model Distribution")
        }
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000_000 {
            return String(format: "%.2fB", Double(count) / 1_000_000_000)
        } else if count >= 1_000_000 {
            return String(format: "%.2fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fk", Double(count) / 1_000)
        }
        return "\(count)"
    }

    private func formatCurrency(_ usd: Double) -> String {
        String(format: "$%.2f", usd)
    }
}
