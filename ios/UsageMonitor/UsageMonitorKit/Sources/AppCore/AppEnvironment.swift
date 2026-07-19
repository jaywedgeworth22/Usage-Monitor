import Foundation
import Observation
import Models
import Networking

/// The single dependency container the app injects into the SwiftUI
/// environment. Feature roots read it with `@Environment(AppEnvironment.self)`
/// and never construct an `APIClient`, `AppSettings`, or `BudgetStore`
/// themselves — they consume the shared instances here.
///
/// ## What lives here
///   - ``settings``   — persisted appearance / host / app-lock preferences.
///   - ``apiClient``  — the shared `Networking.APIClient` actor.
///   - ``budgetStore``— the shared `BudgetStore` that owns the single
///     `GET /api/budget-status` fetch powering Dashboard, Providers, Alerts,
///     and Project budgets. Read it; don't create your own.
///
/// The base host (Settings) can change at runtime; ``reconfigure(host:)``
/// rebuilds the API client and rewires the budget store so a staging switch
/// takes effect without relaunching.
@MainActor
@Observable
public final class AppEnvironment {
    /// Persisted, non-sensitive app preferences.
    public let settings: AppSettings

    /// The shared network client. Rebuilt by ``reconfigure(host:)``.
    public private(set) var apiClient: APIClient

    /// The shared budget-status store. Every budget-driven feature reads this.
    public let budgetStore: BudgetStore

    private let tokenStore: TokenStoring

    /// - Parameters:
    ///   - settings: preferences store (defaults to `UserDefaults.standard`).
    ///   - tokenStore: Keychain-backed by default; inject `InMemoryTokenStore`
    ///     for previews/tests.
    ///   - snapshotSink: where each successful response is persisted (disk
    ///     cache + widget snapshot). Defaults to a no-op; the app target wires
    ///     the real `OfflineCache`/`WidgetShared` adapter.
    public init(
        settings: AppSettings = AppSettings(),
        tokenStore: TokenStoring = KeychainTokenStore(),
        snapshotSink: BudgetSnapshotSink = NullBudgetSnapshotSink()
    ) {
        self.settings = settings
        self.tokenStore = tokenStore
        let configuration = Self.resolveConfiguration(host: settings.baseHost)
        let client = APIClient(configuration: configuration, tokenStore: tokenStore)
        self.apiClient = client
        self.budgetStore = BudgetStore(apiClient: client, sink: snapshotSink)
    }

    /// Whether an API token is currently stored (drives onboarding vs. data).
    public var hasToken: Bool { tokenStore.hasToken }

    /// Persist (or clear, when `nil`/empty) the API token. Settings calls this
    /// after a successful `apiClient.verifyToken()`.
    public func setToken(_ token: String?) throws {
        try tokenStore.setToken(token)
    }

    /// Rebuild the API client after the Settings base host changes, then rewire
    /// the shared budget store to the new client.
    public func reconfigure(host: String) {
        let configuration = Self.resolveConfiguration(host: host)
        let client = APIClient(configuration: configuration, tokenStore: tokenStore)
        self.apiClient = client
        budgetStore.replaceClient(client)
    }

    /// Resolve a user-entered host to an `APIConfiguration`, falling back to
    /// the production monitor when the field is empty or malformed.
    public static func resolveConfiguration(host: String) -> APIConfiguration {
        APIConfiguration.fromUserInput(host) ?? .production
    }

    /// A preview/test environment seeded with an in-memory token and no
    /// network side effects.
    public static func preview(token: String? = "preview-token") -> AppEnvironment {
        AppEnvironment(
            settings: AppSettings(defaults: UserDefaults(suiteName: "preview.usage.monitor") ?? .standard),
            tokenStore: InMemoryTokenStore(token: token)
        )
    }
}
