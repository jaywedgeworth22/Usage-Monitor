import XCTest
import DesignSystem
import WidgetShared

// NOTE: `WidgetPresentation` is a pure, view-free helper compiled from
// `UsageMonitorWidget/WidgetPresentation.swift`. This test target compiles that
// single file directly (see project.yml `UsageMonitorWidgetTests` sources) so
// the mapping/derivation logic is exercised without a WidgetKit host.
final class WidgetPresentationTests: XCTestCase {

    // MARK: - Raw status string -> SemanticStatus

    func testSemanticStatusMapsKnownRawValues() {
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "ok"), .ok)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "warning"), .warning)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "exceeded"), .danger)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "unconfigured"), .neutral)
    }

    func testSemanticStatusDegradesUnknownRawValueToNeutral() {
        // Schema drift must never crash or mis-alarm.
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "totally-new"), .neutral)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: ""), .neutral)
    }

    // MARK: - Fraction

    func testFractionComputesSpentOverBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 200), 0.25, accuracy: 0.0001)
    }

    func testFractionIsZeroWithoutBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: nil), 0)
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 0), 0)
    }

    // MARK: - Overall status / label from snapshot flags

    func testOverallStatusPrioritisesOverBudget() {
        let s = makeSnapshot(overBudget: true, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .danger)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Over budget")
    }

    func testOverallStatusWarning() {
        let s = makeSnapshot(overBudget: false, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .warning)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Approaching")
    }

    func testOverallStatusOkWhenBudgetedAndOnTrack() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .ok)
        XCTAssertNil(WidgetPresentation.overallLabel(for: s))
    }

    func testOverallStatusNeutralWhenNoBudget() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 0)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .neutral)
    }

    // MARK: - Detail / caption strings

    func testMeterDetailDropsDenominatorWithoutBudget() {
        XCTAssertFalse(WidgetPresentation.meterDetail(spent: 42, budget: nil).contains("/"))
        XCTAssertTrue(WidgetPresentation.meterDetail(spent: 42, budget: 100).contains("/"))
    }

    func testBudgetCaptionNilWithoutBudget() {
        XCTAssertNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 0)))
        XCTAssertNotNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 900)))
    }

    // MARK: - Staleness caption

    func testShowsUpdatedAtForRealSnapshot() {
        XCTAssertTrue(WidgetPresentation.showsUpdatedAt(
            for: makeSnapshot(overBudget: false, warning: false, totalBudget: 900)
        ))
        XCTAssertTrue(WidgetPresentation.showsUpdatedAt(for: .placeholder))
    }

    func testHidesUpdatedAtForEmptySnapshot() {
        // The empty sentinel must never render "updated 56 years ago".
        XCTAssertFalse(WidgetPresentation.showsUpdatedAt(for: .empty))
    }

    func testIsStaleWhenOlderThanThreshold() {
        let now = Date(timeIntervalSince1970: 1_720_003_600) // +1h
        let fresh = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-30 * 60)
        )
        let stale = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-2 * 60 * 60)
        )
        XCTAssertFalse(WidgetPresentation.isStale(for: fresh, asOf: now))
        XCTAssertTrue(WidgetPresentation.isStale(for: stale, asOf: now))
        XCTAssertFalse(WidgetPresentation.isStale(for: .empty, asOf: now))
    }

    func testUpdatedCaptionMarksStale() {
        let now = Date(timeIntervalSince1970: 1_720_003_600)
        let stale = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-3 * 60 * 60)
        )
        let caption = WidgetPresentation.updatedCaption(for: stale, asOf: now)
        XCTAssertEqual(caption, "Stale · 3 hr ago")
        XCTAssertNil(WidgetPresentation.updatedCaption(for: .empty, asOf: now))
    }

    func testDisplayAmountRedaction() {
        XCTAssertEqual(WidgetPresentation.displayAmount(42, redacted: true), "••••")
        XCTAssertFalse(WidgetPresentation.displayAmount(42, redacted: false).contains("•"))
        XCTAssertEqual(
            WidgetPresentation.displayMeterDetail(spent: 10, budget: 100, redacted: true),
            "••••"
        )
    }

    // MARK: - Helpers

    private func makeSnapshot(
        overBudget: Bool,
        warning: Bool,
        totalBudget: Double,
        generatedAt: Date = Date(timeIntervalSince1970: 1_720_000_000)
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            month: "2026-07",
            totalSpentUsd: 428.16,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: 690.4,
            percentUsed: totalBudget > 0 ? 428.16 / totalBudget : nil,
            overBudget: overBudget,
            warning: warning,
            topMeters: []
        )
    }
}
