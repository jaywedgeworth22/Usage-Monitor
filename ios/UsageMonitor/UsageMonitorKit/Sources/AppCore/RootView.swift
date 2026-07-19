import SwiftUI
import DesignSystem

/// The five tabs of the app. Also the deep-link / programmatic-selection
/// vocabulary (a notification tap or widget deep link can select a tab).
public enum AppTab: String, CaseIterable, Hashable, Sendable, Identifiable {
    case dashboard
    case providers
    case alerts
    case projects
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .dashboard: return "Overview"
        case .providers: return "Providers"
        case .alerts: return "Alerts"
        case .projects: return "Projects"
        case .settings: return "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .dashboard: return "chart.pie.fill"
        case .providers: return "square.stack.3d.up.fill"
        case .alerts: return "bell.fill"
        case .projects: return "folder.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

/// The feature roots the shell mounts, one closure per tab.
///
/// This is the seam that keeps `AppCore` free of any dependency on the feature
/// targets: the **app target** imports every feature module and supplies its
/// root view here (each feature exposes a `public struct <Name>RootView: View`
/// with a `public init()`), while `AppCore` only ever calls the closures. That
/// is exactly why nine agents can build features in parallel without editing a
/// shared file.
public struct AppFeatures {
    public var dashboard: () -> AnyView
    public var providers: () -> AnyView
    public var alerts: () -> AnyView
    public var projects: () -> AnyView
    public var settings: () -> AnyView

    public init(
        dashboard: @escaping () -> AnyView,
        providers: @escaping () -> AnyView,
        alerts: @escaping () -> AnyView,
        projects: @escaping () -> AnyView,
        settings: @escaping () -> AnyView
    ) {
        self.dashboard = dashboard
        self.providers = providers
        self.alerts = alerts
        self.projects = projects
        self.settings = settings
    }
}

/// The app's root scaffold: a five-tab `TabView` that mounts the injected
/// feature roots, injects the shared environment, applies the accent tint and
/// the user's appearance preference.
///
/// Each feature root is responsible for its own `NavigationStack` and
/// navigation title (a feature owns everything inside its tab). The shell owns
/// only tab selection and app-wide chrome.
public struct RootView: View {
    private let environment: AppEnvironment
    private let features: AppFeatures
    @State private var selection: AppTab

    public init(
        environment: AppEnvironment,
        features: AppFeatures,
        initialTab: AppTab = .dashboard
    ) {
        self.environment = environment
        self.features = features
        self._selection = State(initialValue: initialTab)
    }

    public var body: some View {
        TabView(selection: $selection) {
            tab(.dashboard) { features.dashboard() }
            tab(.providers) { features.providers() }
            tab(.alerts) { features.alerts() }
            tab(.projects) { features.projects() }
            tab(.settings) { features.settings() }
        }
        .tint(Theme.Colors.accent)
        // Canonical injection: everything is reachable via AppEnvironment;
        // BudgetStore and AppSettings are also provided directly for ergonomic
        // `@Environment(BudgetStore.self)` / `@Environment(AppSettings.self)`.
        .environment(environment)
        .environment(environment.budgetStore)
        .environment(environment.settings)
        .preferredColorScheme(environment.settings.theme.colorScheme)
    }

    private func tab(_ tab: AppTab, @ViewBuilder content: () -> some View) -> some View {
        content()
            .tabItem { Label(tab.title, systemImage: tab.systemImage) }
            .tag(tab)
    }
}
