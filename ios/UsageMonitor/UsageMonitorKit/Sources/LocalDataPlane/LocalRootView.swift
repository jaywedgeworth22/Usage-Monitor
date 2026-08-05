import SwiftUI
import DesignSystem
import LocalStore

/// Root shell for **Usage Monitor Local** until feature lanes bind to BudgetEngine.
///
/// Deliberately does **not** import Networking or mount remote `BudgetStore` —
/// the Local app must never dual-write cash against a remote host.
public struct LocalRootView: View {
    @State private var status: LocalDataPlaneStatus = .scaffold
    @State private var storeMessage: String = "Opening local store…"

    private let store: any LocalStoring

    public init(store: any LocalStoring = PlaceholderLocalStore.shared) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    productSplitCard
                    statusCard
                    roadmapCard
                }
                .padding(Theme.Spacing.lg)
            }
            .dsScreenBackground()
            .navigationTitle(status.appDisplayName)
            .navigationBarTitleDisplayMode(.large)
            .task { await openStore() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Your phone is the instance")
                .font(Theme.Typography.title)
                .foregroundStyle(Theme.Colors.primaryText)
            Text(
                "Provider keys stay in Keychain. Budgets and subscriptions will live in on-device SQLite — no Oracle/VPS required for this app."
            )
            .font(Theme.Typography.body)
            .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private var productSplitCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Two apps in this project")
            labeledRow(
                title: "Usage Monitor",
                subtitle: "Live sync with a self-hosted or owner server (how the fleet runs today)."
            )
            labeledRow(
                title: "Usage Monitor Local (this app)",
                subtitle: "Standalone on-device self-host. Separate bundle ID and app group."
            )
        }
        .dsCard()
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Data plane status")
            labeledRow(title: "Phase", subtitle: status.phase.rawValue)
            labeledRow(title: "Schema version", subtitle: "\(status.schemaVersion) (0 = scaffold)")
            labeledRow(title: "Store", subtitle: storeMessage)
            Text(status.detail)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .dsCard()
    }

    private var roadmapCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Milestone A roadmap")
            Text("1. LocalStore GRDB + DDL (PR-2)")
            Text("2. Keychain provider / subscription CRUD")
            Text("3. OpenRouter poll adapter")
            Text("4. BudgetEngine + widget snapshot")
            Text("5. Background refresh + materializer")
        }
        .font(Theme.Typography.callout)
        .foregroundStyle(Theme.Colors.secondaryText)
        .dsCard()
    }

    private func labeledRow(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(title)
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.primaryText)
            Text(subtitle)
                .font(Theme.Typography.callout)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func openStore() async {
        do {
            try await store.open()
            let version = await store.schemaVersion
            status = LocalDataPlaneStatus(
                phase: version >= 1 ? .storeReady : .scaffold,
                schemaVersion: version,
                detail: status.detail
            )
            storeMessage = version == 0
                ? "Placeholder open (no tables yet)."
                : "Migration v\(version) ready."
        } catch {
            storeMessage = "Failed to open: \(error.localizedDescription)"
        }
    }
}

#if DEBUG
#Preview("Local root") {
    LocalRootView()
}
#endif
