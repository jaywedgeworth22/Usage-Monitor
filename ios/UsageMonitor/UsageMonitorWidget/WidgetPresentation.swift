import Foundation
import DesignSystem
import WidgetShared

/// Which budget the home-screen widget focuses on.
///
/// - `overall` — account-wide provider-scoped totals (default).
/// - `project(id:)` — a single project's budget from the cached snapshot.
enum WidgetBudgetFocus: Equatable, Sendable {
    case overall
    case project(id: String)

    /// Stable id used by App Intents / deep links (`overall` or `project:<id>`).
    var selectionId: String {
        switch self {
        case .overall: return "overall"
        case .project(let id): return "project:\(id)"
        }
    }

    static func parse(selectionId: String?) -> WidgetBudgetFocus {
        guard let selectionId, !selectionId.isEmpty, selectionId != "overall" else {
            return .overall
        }
        if selectionId.hasPrefix("project:") {
            let id = String(selectionId.dropFirst("project:".count))
            return id.isEmpty ? .overall : .project(id: id)
        }
        // Bare project ids from older intent payloads.
        return .project(id: selectionId)
    }
}

/// Resolved numbers + chrome for one widget configuration.
struct WidgetBudgetContent: Equatable, Sendable {
    var focus: WidgetBudgetFocus
    /// Short caption above the hero total ("Overall" / project name).
    var title: String
    var spentUsd: Double
    var budgetUsd: Double
    var projectedEomUsd: Double
    var percentUsed: Double?
    var overBudget: Bool
    var warning: Bool
    /// Medium-family side list (providers when overall; empty for a project).
    var meters: [WidgetSnapshot.Meter]
    var deepLink: URL?
    /// True when a project focus was requested but that project is missing.
    var fellBackToOverall: Bool
}

/// Pure, view-free presentation logic for the budget widget.
///
/// Kept deliberately separate from the SwiftUI views so the status mapping and
/// derivation math are unit-testable without a rendering context. This lane is
/// model- and networking-free by contract, so the raw status *string* carried
/// on `WidgetSnapshot.Meter` is mapped onto `Theme.SemanticStatus` here rather
/// than via AppCore's `Theme.SemanticStatus(_ level:)` bridge (which lives in a
/// layer the widget must not depend on).
enum WidgetPresentation {
    /// Age past which the widget treats cached spend as stale (1 hour). Longer
    /// than the in-app 15-minute threshold because widgets refresh less often.
    static let staleThreshold: TimeInterval = 60 * 60

    /// Resolve the numbers the widget renders for a given focus selection.
    static func content(
        from snapshot: WidgetSnapshot,
        focus: WidgetBudgetFocus,
        maxMeters: Int = 3
    ) -> WidgetBudgetContent {
        switch focus {
        case .overall:
            return overallContent(from: snapshot, maxMeters: maxMeters, fellBack: false)
        case .project(let id):
            if let project = snapshot.projects.first(where: { $0.id == id }) {
                let budget = project.budgetUsd ?? 0
                let spent = project.spentUsd
                let over = project.status == "exceeded"
                    || (budget > 0 && spent >= budget)
                let warn = over
                    || project.status == "warning"
                    || (budget > 0 && spent / budget >= 0.8)
                return WidgetBudgetContent(
                    focus: .project(id: id),
                    title: project.name,
                    spentUsd: spent,
                    budgetUsd: budget,
                    projectedEomUsd: project.projectedEomUsd ?? 0,
                    percentUsed: project.percentUsed
                        ?? (budget > 0 ? spent / budget : nil),
                    overBudget: over,
                    warning: warn,
                    meters: [],
                    deepLink: URL(string: "usageclientmonitor://projects"),
                    fellBackToOverall: false
                )
            }
            // Project removed or not yet in cache — show overall rather than zeros.
            return overallContent(from: snapshot, maxMeters: maxMeters, fellBack: true)
        }
    }

    private static func overallContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int,
        fellBack: Bool
    ) -> WidgetBudgetContent {
        WidgetBudgetContent(
            focus: .overall,
            title: "Overall",
            spentUsd: snapshot.totalSpentUsd,
            budgetUsd: snapshot.totalBudgetUsd,
            projectedEomUsd: snapshot.projectedEomUsd,
            percentUsed: snapshot.percentUsed,
            overBudget: snapshot.overBudget,
            warning: snapshot.warning,
            meters: Array(snapshot.topMeters.prefix(maxMeters)),
            deepLink: URL(string: "usageclientmonitor://dashboard"),
            fellBackToOverall: fellBack
        )
    }

    /// Map a raw `WidgetSnapshot.Meter.status` string onto the design system's
    /// semantic status. The raw values mirror the server's `BudgetLevel`:
    /// `"ok" | "warning" | "exceeded" | "unconfigured"`. Anything unexpected
    /// degrades to `.neutral` so a schema drift never crashes or mis-alarms.
    static func semanticStatus(forRawStatus raw: String) -> Theme.SemanticStatus {
        switch raw {
        case "exceeded": return .danger
        case "warning": return .warning
        case "ok": return .ok
        default: return .neutral // "unconfigured" or anything unrecognised
        }
    }

    /// Overall status for the summary hero, derived from the snapshot's flags.
    static func overallStatus(for snapshot: WidgetSnapshot) -> Theme.SemanticStatus {
        status(overBudget: snapshot.overBudget, warning: snapshot.warning, budgetUsd: snapshot.totalBudgetUsd)
    }

    static func status(for content: WidgetBudgetContent) -> Theme.SemanticStatus {
        status(overBudget: content.overBudget, warning: content.warning, budgetUsd: content.budgetUsd)
    }

    private static func status(overBudget: Bool, warning: Bool, budgetUsd: Double) -> Theme.SemanticStatus {
        if overBudget { return .danger }
        if warning { return .warning }
        return budgetUsd > 0 ? .ok : .neutral
    }

    /// Short badge label for the overall summary, or `nil` when on-track (no
    /// badge shown so the small widget stays calm and uncluttered).
    static func overallLabel(for snapshot: WidgetSnapshot) -> String? {
        label(overBudget: snapshot.overBudget, warning: snapshot.warning)
    }

    static func label(for content: WidgetBudgetContent) -> String? {
        label(overBudget: content.overBudget, warning: content.warning)
    }

    private static func label(overBudget: Bool, warning: Bool) -> String? {
        if overBudget { return "Over budget" }
        if warning { return "Approaching" }
        return nil
    }

    /// SF Symbol paired with `overallLabel`.
    static func overallSymbol(for snapshot: WidgetSnapshot) -> String {
        symbol(overBudget: snapshot.overBudget, warning: snapshot.warning)
    }

    static func symbol(for content: WidgetBudgetContent) -> String {
        symbol(overBudget: content.overBudget, warning: content.warning)
    }

    private static func symbol(overBudget: Bool, warning: Bool) -> String {
        if overBudget { return "exclamationmark.octagon.fill" }
        if warning { return "gauge.with.dots.needle.67percent" }
        return "checkmark.circle.fill"
    }

    /// Fraction spent (spent ÷ budget). Returns `0` when there is no budget so
    /// the meter renders an empty track rather than a divide-by-zero.
    static func fraction(spent: Double, budget: Double?) -> Double {
        guard let budget, budget > 0 else { return 0 }
        return spent / budget
    }

    /// Compact `"$212 / $250"` detail for a meter row; drops the denominator
    /// when the provider has no configured budget.
    static func meterDetail(spent: Double, budget: Double?) -> String {
        if let budget, budget > 0 {
            return "\(CurrencyFormat.compactUSD(spent)) / \(CurrencyFormat.compactUSD(budget))"
        }
        return CurrencyFormat.compactUSD(spent)
    }

    /// `"of $900"` sub-caption under the hero total, or `nil` when unbudgeted.
    static func budgetCaption(for snapshot: WidgetSnapshot) -> String? {
        budgetCaption(budgetUsd: snapshot.totalBudgetUsd)
    }

    static func budgetCaption(for content: WidgetBudgetContent) -> String? {
        budgetCaption(budgetUsd: content.budgetUsd)
    }

    private static func budgetCaption(budgetUsd: Double) -> String? {
        guard budgetUsd > 0 else { return nil }
        return "of \(CurrencyFormat.compactUSD(budgetUsd))"
    }

    static func displayBudgetCaption(for content: WidgetBudgetContent, redacted: Bool) -> String? {
        if redacted { return WidgetPrivacy.lockedLabel }
        return budgetCaption(for: content)
    }

    /// Whether the "updated … ago" staleness caption should render. The empty
    /// snapshot (fresh install / signed-out) carries a sentinel epoch
    /// timestamp that must never surface as a relative age; everything else
    /// shows its real `generatedAt` so days-old data is visibly stale.
    static func showsUpdatedAt(for snapshot: WidgetSnapshot) -> Bool {
        !snapshot.month.isEmpty && snapshot.generatedAt.timeIntervalSince1970 > 0
    }

    /// Whether the snapshot is older than ``staleThreshold``. Empty/placeholder
    /// snapshots without a real timestamp are never treated as stale.
    static func isStale(for snapshot: WidgetSnapshot, asOf now: Date = Date()) -> Bool {
        guard showsUpdatedAt(for: snapshot) else { return false }
        return now.timeIntervalSince(snapshot.generatedAt) >= staleThreshold
    }

    /// Caption under the hero: always "Updated …". Age alone is not "Stale" —
    /// the host app / timeline should refresh; never-pollable spend is Manual.
    /// Returns `nil` for empty snapshots that must not show an age.
    static func updatedCaption(for snapshot: WidgetSnapshot, asOf now: Date = Date()) -> String? {
        guard showsUpdatedAt(for: snapshot) else { return nil }
        let relative = relativeAge(since: snapshot.generatedAt, asOf: now)
        return "Updated \(relative)"
    }

    /// Compact relative age phrase for widget chrome.
    static func relativeAge(since date: Date, asOf now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 45 { return "just now" }
        if seconds < 90 { return "1 min ago" }
        if seconds < 3600 {
            let mins = Int((seconds / 60).rounded())
            return "\(mins) min ago"
        }
        if seconds < 90 * 60 { return "1 hr ago" }
        if seconds < 36 * 3600 {
            let hours = Int((seconds / 3600).rounded())
            return "\(hours) hr ago"
        }
        let days = max(1, Int((seconds / 86_400).rounded()))
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// True when the host app mirrored `settings.appLockEnabled` into the
    /// App Group (`WidgetPrivacy` / `AppSettings.mirrorAppLockToSharedDefaults`).
    /// Always-on while lock is enabled (presentation-time redaction only).
    static func shouldRedactAmounts(appGroupDefaults: UserDefaults = AppGroup.defaults) -> Bool {
        WidgetPrivacy.isAppLockEnabled(defaults: appGroupDefaults)
    }

    /// Display string for a USD amount, or a redacted placeholder when privacy
    /// redaction is active.
    static func displayAmount(_ usd: Double, redacted: Bool) -> String {
        redacted ? WidgetPrivacy.redactedAmount : CurrencyFormat.compactUSD(usd)
    }

    /// Budget caption under the hero, or `"Locked"` when redacted so the
    /// ceiling is never leaked on the home screen.
    static func displayBudgetCaption(for snapshot: WidgetSnapshot, redacted: Bool) -> String? {
        if redacted { return WidgetPrivacy.lockedLabel }
        return budgetCaption(for: snapshot)
    }

    static func displayMeterDetail(spent: Double, budget: Double?, redacted: Bool) -> String {
        if redacted { return WidgetPrivacy.redactedAmount }
        return meterDetail(spent: spent, budget: budget)
    }
}

/// Gallery / Edit Widget topic.  One widget kind; users add copies per topic.
enum WidgetTopic: String, Equatable, Sendable {
    case budget
    case llmQuotas
    case servers

    var title: String {
        switch self {
        case .budget: return "Budget"
        case .llmQuotas: return "LLM Quotas"
        case .servers: return "Servers"
        }
    }

    static func parse(_ raw: String?) -> WidgetTopic {
        guard let raw else { return .budget }
        return WidgetTopic(rawValue: raw) ?? .budget
    }
}

enum WidgetServerFocus: Equatable, Sendable {
    case service
    case host
    case app(id: String)

    var selectionId: String {
        switch self {
        case .service: return "server:service"
        case .host: return "server:host"
        case .app(let id): return "server:app:\(id)"
        }
    }

    static func parse(selectionId: String?) -> WidgetServerFocus {
        guard let selectionId, !selectionId.isEmpty, selectionId != "server:service" else {
            return .service
        }
        if selectionId == "server:host" { return .host }
        if selectionId.hasPrefix("server:app:") {
            let id = String(selectionId.dropFirst("server:app:".count))
            return id.isEmpty ? .service : .app(id: id)
        }
        if selectionId.hasPrefix("app:") {
            let id = String(selectionId.dropFirst("app:".count))
            return id.isEmpty ? .service : .app(id: id)
        }
        return .service
    }
}

/// Honest empty / missing-cache copy.  Never rewrite a missing metric as $0.
struct WidgetUnavailableContent: Equatable, Sendable {
    var title: String
    var message: String
    var deepLink: URL?
}

struct WidgetLlmContent: Equatable, Sendable {
    var provider: WidgetSnapshot.LlmSection.Provider
    var windowHours: Double?
    var peers: [WidgetSnapshot.LlmSection.Provider]
    var generatedAt: Date
    var deepLink: URL?
}

struct WidgetServerContent: Equatable, Sendable {
    var focus: WidgetServerFocus
    var title: String
    var generatedAt: Date
    var service: WidgetSnapshot.ServerSection.Service?
    var host: WidgetSnapshot.ServerSection.Host?
    var app: WidgetSnapshot.ServerSection.App?
    var apps: [WidgetSnapshot.ServerSection.App]
    var deepLink: URL?
}

enum WidgetTopicContent: Equatable, Sendable {
    case budget(WidgetBudgetContent)
    case llm(WidgetLlmContent)
    case server(WidgetServerContent)
    case unavailable(WidgetUnavailableContent)
}

enum WidgetTopicPresentation {
    static func topicContent(
        from snapshot: WidgetSnapshot,
        topic: WidgetTopic,
        budgetFocus: WidgetBudgetFocus,
        llmProviderId: String?,
        serverFocus: WidgetServerFocus,
        maxMeters: Int = 3
    ) -> WidgetTopicContent {
        switch topic {
        case .budget:
            return .budget(
                WidgetPresentation.content(from: snapshot, focus: budgetFocus, maxMeters: maxMeters)
            )
        case .llmQuotas:
            return llmContent(from: snapshot, providerId: llmProviderId)
        case .servers:
            return serverContent(from: snapshot, focus: serverFocus)
        }
    }

    static func llmContent(
        from snapshot: WidgetSnapshot,
        providerId: String?
    ) -> WidgetTopicContent {
        guard let section = snapshot.llm else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "Open the app to load LLM quotas.",
                    deepLink: URL(string: "usageclientmonitor://dashboard")
                )
            )
        }
        if section.providers.isEmpty {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "No LLM activity in the latest window.",
                    deepLink: URL(string: "usageclientmonitor://dashboard")
                )
            )
        }
        let selected: WidgetSnapshot.LlmSection.Provider?
        if let providerId, !providerId.isEmpty {
            selected = section.providers.first { $0.id.caseInsensitiveCompare(providerId) == .orderedSame }
            if selected == nil {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "LLM Quotas",
                        message: "That provider is not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://dashboard")
                    )
                )
            }
        } else {
            selected = section.providers.first { !$0.quiet } ?? section.providers.first
        }
        guard let provider = selected else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "No LLM activity in the latest window.",
                    deepLink: URL(string: "usageclientmonitor://dashboard")
                )
            )
        }
        return .llm(
            WidgetLlmContent(
                provider: provider,
                windowHours: section.windowHours,
                peers: section.providers.filter { $0.id != provider.id },
                generatedAt: section.generatedAt,
                deepLink: URL(string: "usageclientmonitor://dashboard")
            )
        )
    }

    static func serverContent(
        from snapshot: WidgetSnapshot,
        focus: WidgetServerFocus
    ) -> WidgetTopicContent {
        let section = snapshot.servers
        switch focus {
        case .service:
            guard let service = section?.service else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Servers",
                        message: "Open the app to load server status.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus")
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .service,
                    title: service.name,
                    generatedAt: service.generatedAt,
                    service: service,
                    host: section?.host,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        case .host:
            guard let host = section?.host else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Host",
                        message: "Host metrics are not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus")
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .host,
                    title: host.name ?? "Host",
                    generatedAt: host.generatedAt,
                    host: host,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        case .app(let id):
            guard let app = section?.apps.first(where: { $0.id == id }) else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Servers",
                        message: "That app is not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus")
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .app(id: id),
                    title: app.name,
                    generatedAt: section?.host?.generatedAt ?? section?.service?.generatedAt ?? snapshot.generatedAt,
                    app: app,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        }
    }

    /// Recorded-wins display cost: estimate, else derived, else reported.
    /// Returns `nil` when the cache has no cost so the widget cannot show $0 as live.
    static func llmDisplayCostUsd(for provider: WidgetSnapshot.LlmSection.Provider) -> Double? {
        provider.estimateUsd ?? provider.derivedCostUsd ?? provider.reportedCostUsd
    }

    static func llmCostCaption(for provider: WidgetSnapshot.LlmSection.Provider, redacted: Bool) -> String? {
        guard let usd = llmDisplayCostUsd(for: provider) else { return nil }
        return WidgetPresentation.displayAmount(usd, redacted: redacted)
    }

    static func llmTokenCaption(for provider: WidgetSnapshot.LlmSection.Provider) -> String {
        "\(compactCount(provider.tokensTotal)) tok"
    }

    static func llmWindowCaption(hours: Double?) -> String? {
        guard let hours, hours > 0 else { return nil }
        if hours == 1 { return "Last 1 hour" }
        if hours == floor(hours) {
            return "Last \(Int(hours)) hours"
        }
        return "Last \(hours) hours"
    }

    static func llmBudgetStatus(_ raw: String?) -> Theme.SemanticStatus {
        switch raw {
        case "over-pace": return .danger
        case "watch": return .warning
        case "on-pace": return .ok
        default: return .neutral
        }
    }

    static func llmBudgetLabel(_ raw: String?) -> String? {
        switch raw {
        case "over-pace": return "Over pace"
        case "watch": return "Watch"
        case "on-pace": return "On pace"
        case "no-budget": return nil
        default: return nil
        }
    }

    static func serverOverallLabel(for service: WidgetSnapshot.ServerSection.Service) -> String {
        if !service.ok { return "Offline" }
        if let ready = service.readyOk, !ready { return "Degraded" }
        return "Operational"
    }

    static func serverOverallStatus(for service: WidgetSnapshot.ServerSection.Service) -> Theme.SemanticStatus {
        if !service.ok { return .danger }
        if let ready = service.readyOk, !ready { return .warning }
        return .ok
    }

    static func serverCheckLabel(_ check: WidgetSnapshot.ServerSection.Check) -> String {
        if check.ok { return "OK" }
        return check.gatesService ? "Down" : "Lagging"
    }

    static func serverCheckStatus(_ check: WidgetSnapshot.ServerSection.Check) -> Theme.SemanticStatus {
        if check.ok { return .ok }
        return check.gatesService ? .danger : .warning
    }

    static func serverCheckDetail(_ check: WidgetSnapshot.ServerSection.Check) -> String? {
        if let detail = check.detail, !detail.isEmpty { return detail }
        return DiskFormat.summary(free: check.freeBytes, total: check.totalBytes)
    }

    static func hostStatus(_ host: WidgetSnapshot.ServerSection.Host) -> Theme.SemanticStatus {
        if host.stale || host.degraded { return .warning }
        switch host.preventionOverall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    static func hostLabel(_ host: WidgetSnapshot.ServerSection.Host) -> String {
        if host.stale { return "Stale" }
        if host.degraded { return "Degraded" }
        switch host.preventionOverall {
        case "critical": return "Critical"
        case "warning": return "Watch"
        case "ok": return "Live"
        default:
            return host.status?.capitalized ?? "Host"
        }
    }

    static func appLabel(_ status: String) -> String {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return "Stopped" }
        if lower.contains("unhealthy") { return "Unhealthy" }
        if lower.contains("healthy") || lower == "running" { return "Healthy" }
        if lower.contains("unknown") { return "Unknown" }
        if lower.contains("degraded") { return "Degraded" }
        return status
    }

    static func appStatus(_ status: String) -> Theme.SemanticStatus {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return .danger }
        if lower.contains("unhealthy") { return .danger }
        if lower.contains("healthy") || lower == "running" { return .ok }
        if lower.contains("unknown") { return .warning }
        if lower.contains("degraded") { return .warning }
        return .warning
    }

    static func showsUpdatedAt(generatedAt: Date) -> Bool {
        generatedAt.timeIntervalSince1970 > 0
    }

    static func isStale(generatedAt: Date, asOf now: Date = Date()) -> Bool {
        guard showsUpdatedAt(generatedAt: generatedAt) else { return false }
        return now.timeIntervalSince(generatedAt) >= WidgetPresentation.staleThreshold
    }

    static func updatedCaption(generatedAt: Date, asOf now: Date = Date()) -> String? {
        guard showsUpdatedAt(generatedAt: generatedAt) else { return nil }
        return "Updated \(WidgetPresentation.relativeAge(since: generatedAt, asOf: now))"
    }

    static func generatedAt(for content: WidgetTopicContent, snapshot: WidgetSnapshot) -> Date? {
        switch content {
        case .budget:
            return WidgetPresentation.showsUpdatedAt(for: snapshot) ? snapshot.generatedAt : nil
        case .llm(let llm):
            return showsUpdatedAt(generatedAt: llm.generatedAt) ? llm.generatedAt : nil
        case .server(let server):
            return showsUpdatedAt(generatedAt: server.generatedAt) ? server.generatedAt : nil
        case .unavailable:
            return nil
        }
    }

    static func compactCount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "0"
    }
}

