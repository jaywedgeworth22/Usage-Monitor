import Foundation
import DesignSystem
import WidgetShared

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
        if snapshot.overBudget { return .danger }
        if snapshot.warning { return .warning }
        return snapshot.totalBudgetUsd > 0 ? .ok : .neutral
    }

    /// Short badge label for the overall summary, or `nil` when on-track (no
    /// badge shown so the small widget stays calm and uncluttered).
    static func overallLabel(for snapshot: WidgetSnapshot) -> String? {
        if snapshot.overBudget { return "Over budget" }
        if snapshot.warning { return "Approaching" }
        return nil
    }

    /// SF Symbol paired with `overallLabel`.
    static func overallSymbol(for snapshot: WidgetSnapshot) -> String {
        if snapshot.overBudget { return "exclamationmark.octagon.fill" }
        if snapshot.warning { return "gauge.with.dots.needle.67percent" }
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
        guard snapshot.totalBudgetUsd > 0 else { return nil }
        return "of \(CurrencyFormat.compactUSD(snapshot.totalBudgetUsd))"
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
