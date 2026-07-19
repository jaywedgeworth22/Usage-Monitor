import SwiftUI
import AppCore
import DesignSystem
import Networking

/// PLACEHOLDER — owned by the **Settings** lane. Replace with token entry,
/// appearance picker, host override, app-lock toggle, and server health.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `SettingsRootView` with `public init()`.
///   - Read `@Environment(AppEnvironment.self)` for `settings`, `apiClient`,
///     `hasToken`, `setToken(_:)`, and `reconfigure(host:)`.
///   - Token entry MUST verify with `try await env.apiClient.verifyToken()`
///     before calling `env.setToken(...)`. Never store the token in
///     `AppSettings`/`UserDefaults` — it belongs in the Keychain (handled by
///     `setToken`).
public struct SettingsRootView: View {
    @Environment(AppEnvironment.self) private var env

    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                systemImage: "gearshape.fill",
                title: "Settings",
                message: "The settings lane is under construction. API token entry, appearance, host override, and app lock land here."
            )
            .navigationTitle(AppTab.settings.title)
        }
    }
}
