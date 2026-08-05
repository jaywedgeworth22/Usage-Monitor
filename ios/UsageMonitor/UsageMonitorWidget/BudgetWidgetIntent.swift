import AppIntents
import WidgetKit
import WidgetShared

// MARK: - Entity

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

// MARK: - Configuration intent

struct SelectBudgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Budget"
    static var description = IntentDescription("Choose overall spend or a project budget.")

    @Parameter(title: "Budget", default: nil)
    var budget: BudgetFocusEntity?

    /// Resolved focus for timeline providers.
    var focus: WidgetBudgetFocus {
        WidgetBudgetFocus.parse(selectionId: budget?.id)
    }
}
