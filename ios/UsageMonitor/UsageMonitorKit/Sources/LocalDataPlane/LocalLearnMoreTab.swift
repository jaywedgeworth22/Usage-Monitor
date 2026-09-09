import SwiftUI

/// "Learn More" tab for **Usage Local Monitor** — the on-device self-host
/// product.  Owner 2026-09-09: "just have one part of local app that is a tab
/// for info about the server and client app including: features that setup
/// has, the big picture overview of how it works (not details), and
/// info/link to where they can go to learn more."
///
/// Content is intentionally **non-actionable**: it explains what the
/// three-piece fleet looks like, what the on-device app does and does not
/// do, and where to read more (server URL, client URL, GitHub).  No live
/// data sources, no data plane, no Settings state.
public struct LocalLearnMoreTab: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                sectionOverview
                sectionFeatures
                sectionFleet
                sectionLearnMore
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Learn More")
        }
    }

    // MARK: - Sections

    private var sectionOverview: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("This is **Usage Local Monitor** — the on-device self-host product. It runs entirely on this device: SQLite for money, Keychain for API keys, no remote server required.")
                    .font(Theme.Typography.body)
                Text("It is one of three pieces in Jay's usage-tracking fleet. The other two are the hosted server (Usage.Jays.Services) and the iOS client app (the App Store build).")
                    .font(Theme.Typography.body)
            }
        } header: {
            Text("What This App Is")
        }
    }

    private var sectionFeatures: some View {
        Section {
            featureRow(
                icon: "chart.pie.fill",
                title: "Month-To-Date Spend",
                detail: "Aggregates every connected provider, subscription, and one-off charge into one USD total with budget pacing."
            )
            featureRow(
                icon: "calendar",
                title: "Recurring Fees",
                detail: "Materializes one synthetic charge per billing period per subscription, so subscription cost flows through the same MTD math as polled usage."
            )
            featureRow(
                icon: "square.and.arrow.down",
                title: "Encrypted Backup",
                detail: "Exports a JSON package (cards + budgets + fees, no API keys) and re-imports it on a fresh device."
            )
            featureRow(
                icon: "faceid",
                title: "App Lock",
                detail: "Optional Face ID / passcode gate before the dashboard opens, so the on-device money view is private."
            )
            featureRow(
                icon: "icloud.slash.fill",
                title: "Fully Offline",
                detail: "Works on a plane. The poll adapters hit each provider directly over the public internet; no Mac, no Coolify, no account."
            )
        } header: {
            Text("Features")
        } footer: {
            Text("Every card on the dashboard reads from the on-device SQLite database. Provider API keys live in iOS Keychain and never leave the device.")
        }
    }

    private var sectionFleet: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                fleetRow(
                    icon: "iphone",
                    color: Color(red: 0.05, green: 0.72, blue: 0.68),
                    title: "Usage Local Monitor (this app)",
                    detail: "On-device self-host. SQLite + Keychain. No server."
                )
                fleetRow(
                    icon: "globe",
                    color: Color.blue,
                    title: "Usage.Jays.Services — server",
                    detail: "Hosted dashboard. Sentry, Sentry Metrics, Datadog. Pulls from every cloud account the user has on file."
                )
                fleetRow(
                    icon: "applelogo",
                    color: Color.indigo,
                    title: "Usage Monitor — iOS client",
                    detail: "App Store build. Reads the server dashboard, the same charts on the phone."
                )
                Text("How the pieces fit together: the server runs in Coolify and ingests from cloud provider APIs, OTLP endpoints, and push telemetry. The iOS client is a thin read-only view. The local app is a full self-host instance that talks directly to each provider API and does not depend on the server being up.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        } header: {
            Text("The Three Pieces")
        }
    }

    private var sectionLearnMore: some View {
        Section {
            linkRow(
                icon: "globe",
                title: "Server Dashboard",
                detail: "usage.jays.services",
                url: "https://usage.jays.services"
            )
            linkRow(
                icon: "applelogo",
                title: "iOS Client App",
                detail: "App Store — search \"Usage Monitor\" by Jay Wedgeworth",
                url: "https://apps.apple.com/search?term=usage%20monitor%20jays%20services"
            )
            linkRow(
                icon: "chevron.left.forwardslash.chevron.right",
                title: "Source on GitHub",
                detail: "github.com/jaywedgeworth22/Usage-Monitor",
                url: "https://github.com/jaywedgeworth22/Usage-Monitor"
            )
            linkRow(
                icon: "envelope",
                title: "Owner Contact",
                detail: "mail@jays.services",
                url: "mailto:mail@jays.services"
            )
        } header: {
            Text("Learn More")
        } footer: {
            Text("Documentation, agent-sync protocol, and the rollout history live in the GitHub repo's docs/ directory. Owner changes flow through fleet-coordinated PRs; check mac.jays.services/board for the live fleet status board.")
        }
    }

    // MARK: - Reusable rows

    private func featureRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .padding(.vertical, 2)
    }

    private func fleetRow(icon: String, color: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(color, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private func linkRow(icon: String, title: String, detail: String, url: String) -> some View {
        Link(destination: URL(string: url) ?? URL(string: "https://usage.jays.services")!) {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(detail)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer()
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }
}
