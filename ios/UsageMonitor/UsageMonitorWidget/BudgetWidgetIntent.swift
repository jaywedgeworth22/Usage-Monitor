import AppIntents
import WidgetKit
import WidgetShared

// MARK: - Topic

enum WidgetTopicChoice: String, AppEnum {
    case budget
    case llmQuotas
    case servers
    case mac
    case alerts
    case providers

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Topic")

    static var caseDisplayRepresentations: [WidgetTopicChoice: DisplayRepresentation] = [
        .budget: "Budget",
        .llmQuotas: "LLM Quotas",
        .servers: "Servers",
        .mac: "Mac",
        .alerts: "Alerts",
        .providers: "Providers"
    ]

    var topic: WidgetTopic {
        switch self {
        case .budget: return .budget
        case .llmQuotas: return .llmQuotas
        case .servers: return .servers
        case .mac: return .mac
        case .alerts: return .alerts
        case .providers: return .providers
        }
    }
}

// MARK: - Budget entity (existing)

/// One selectable budget focus for the home-screen widget.
///
/// Options are built from the latest app-group `WidgetSnapshot` so the picker
/// lists "Overall" plus every known project without a network call.
struct BudgetFocusEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Budget")
    static var defaultQuery = BudgetFocusEntityQuery()

    var id: String
    var title: String
    var subtitle: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: subtitle.map { "\($0)" })
    }

    static var overall: BudgetFocusEntity {
        BudgetFocusEntity(
            id: WidgetBudgetFocus.overall.selectionId,
            title: "Overall",
            subtitle: "All providers (account total)"
        )
    }
}

struct BudgetFocusEntityQuery: EntityQuery {
    func entities(for identifiers: [BudgetFocusEntity.ID]) async throws -> [BudgetFocusEntity] {
        let all = availableEntities()
        let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        return identifiers.compactMap { byId[$0] }
    }

    func suggestedEntities() async throws -> [BudgetFocusEntity] {
        availableEntities()
    }

    func defaultResult() async -> BudgetFocusEntity? {
        .overall
    }

    private func availableEntities() -> [BudgetFocusEntity] {
        let snapshot = SharedStore.shared.read() ?? .empty
        var entities: [BudgetFocusEntity] = [.overall]
        for project in snapshot.projects {
            let detail: String
            if let budget = project.budgetUsd, budget > 0 {
                detail = "Project · budget set"
            } else {
                detail = "Project · no budget"
            }
            entities.append(
                BudgetFocusEntity(
                    id: WidgetBudgetFocus.project(id: project.id).selectionId,
                    title: project.name,
                    subtitle: detail
                )
            )
        }
        return entities
    }
}

// MARK: - LLM entity

struct LlmProviderEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "LLM Provider")
    static var defaultQuery = LlmProviderEntityQuery()

    var id: String
    var title: String
    var subtitle: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: subtitle.map { "\($0)" })
    }
}

struct LlmProviderEntityQuery: EntityQuery {
    func entities(for identifiers: [LlmProviderEntity.ID]) async throws -> [LlmProviderEntity] {
        let all = availableEntities()
        let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        return identifiers.compactMap { byId[$0] }
    }

    func suggestedEntities() async throws -> [LlmProviderEntity] {
        availableEntities()
    }

    func defaultResult() async -> LlmProviderEntity? {
        availableEntities().first
    }

    private func availableEntities() -> [LlmProviderEntity] {
        let snapshot = SharedStore.shared.read() ?? .empty
        return (snapshot.llm?.providers ?? []).map { provider in
            LlmProviderEntity(
                id: provider.id,
                title: provider.name,
                subtitle: provider.quiet ? "Quiet in the latest window" : "LLM Quotas"
            )
        }
    }
}

// MARK: - Server entity

struct ServerFocusEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Server")
    static var defaultQuery = ServerFocusEntityQuery()

    var id: String
    var title: String
    var subtitle: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: subtitle.map { "\($0)" })
    }

    static var service: ServerFocusEntity {
        ServerFocusEntity(
            id: WidgetServerFocus.service.selectionId,
            title: "Usage Monitor",
            subtitle: "Service status"
        )
    }

    static var host: ServerFocusEntity {
        ServerFocusEntity(
            id: WidgetServerFocus.host.selectionId,
            title: "Host",
            subtitle: "Host metrics"
        )
    }
}

struct ServerFocusEntityQuery: EntityQuery {
    func entities(for identifiers: [ServerFocusEntity.ID]) async throws -> [ServerFocusEntity] {
        let all = availableEntities()
        let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        return identifiers.compactMap { byId[$0] }
    }

    func suggestedEntities() async throws -> [ServerFocusEntity] {
        availableEntities()
    }

    func defaultResult() async -> ServerFocusEntity? {
        .service
    }

    private func availableEntities() -> [ServerFocusEntity] {
        let snapshot = SharedStore.shared.read() ?? .empty
        var entities: [ServerFocusEntity] = [.service]
        if let host = snapshot.servers?.host {
            entities.append(
                ServerFocusEntity(
                    id: WidgetServerFocus.host.selectionId,
                    title: host.name ?? "Host",
                    subtitle: "Host metrics"
                )
            )
        } else {
            entities.append(.host)
        }
        for app in snapshot.servers?.apps ?? [] {
            entities.append(
                ServerFocusEntity(
                    id: WidgetServerFocus.app(id: app.id).selectionId,
                    title: app.name,
                    subtitle: app.selfApp ? "This app" : "App on host"
                )
            )
        }
        return entities
    }
}

// MARK: - Configuration intent

struct SelectBudgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Usage Monitor"
    static var description = IntentDescription(
        "Choose Budget, LLM Quotas, Servers, Mac, Alerts, or Providers.  Add more than one copy to watch different topics."
    )

    @Parameter(title: "Topic", default: .budget)
    var topic: WidgetTopicChoice

    @Parameter(title: "Budget", default: nil)
    var budget: BudgetFocusEntity?

    @Parameter(title: "LLM Provider", default: nil)
    var llmProvider: LlmProviderEntity?

    @Parameter(title: "Server", default: nil)
    var server: ServerFocusEntity?

    /// Resolved budget focus for timeline providers (existing widgets).
    var focus: WidgetBudgetFocus {
        WidgetBudgetFocus.parse(selectionId: budget?.id)
    }

    var resolvedTopic: WidgetTopic { topic.topic }

    var resolvedServerFocus: WidgetServerFocus {
        WidgetServerFocus.parse(selectionId: server?.id)
    }
}
