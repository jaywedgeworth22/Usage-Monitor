import SwiftUI
import DesignSystem
import Models
import AppCore

struct IntelligenceSection: View {
    @Bindable var store: IntelligenceStore
    var onOpenSettings: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Intelligence")

            if store.requiresSession {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Full dashboard access required")
                        .font(Theme.Typography.callout.weight(.semibold))
                    Text("Sign in with the dashboard password in Settings to load LLM burn analytics.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    if let onOpenSettings {
                        Button("Open Settings", action: onOpenSettings)
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.Colors.accent)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .dsCard()
            } else if let burn = store.burn, burn.ok, burn.hasActivity {
                LlmBurnCard(response: burn)
            } else if store.burnState.isLoading {
                SkeletonBlock(height: 120, radius: Theme.Radius.lg)
            } else if case .failed(let error) = store.burnState {
                Text(error.localizedDescription)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .dsCard()
            }
        }
    }
}

struct LlmBurnCard: View {
    let response: LlmBurnResponse

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("LLM burn")
                .font(Theme.Typography.sectionHeader)
                .foregroundStyle(Theme.Colors.primaryText)
            Text("Trailing window analytics — not cash budget.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)

            ForEach(response.providers.prefix(6)) { row in
                HStack {
                    Text(row.provider)
                        .font(Theme.Typography.callout.weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        if let usd = row.window.estimateUsd ?? row.window.derivedCostUsd ?? row.window.reportedCostUsd {
                            Text(usd, format: .currency(code: "USD"))
                                .font(Theme.Typography.captionEmphasis)
                                .monospacedDigit()
                        }
                        Text("\(Int(row.window.tokens.total)) tok")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}
