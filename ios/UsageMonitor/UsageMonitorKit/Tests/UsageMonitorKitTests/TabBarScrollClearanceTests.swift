import XCTest
@testable import DesignSystem

final class TabBarScrollClearanceTests: XCTestCase {
    func testClearanceIsEnoughForATwoLineFormFooter() {
        XCTAssertGreaterThanOrEqual(Theme.Spacing.tabBarClearance, 24)
        XCTAssertLessThanOrEqual(Theme.Spacing.tabBarClearance, Theme.Spacing.xxxl)
    }
}
