import XCTest
@testable import DesignSystem

final class TabBarScrollClearanceTests: XCTestCase {
    func testClearanceCoversTheFloatingGlassTabBar() {
        XCTAssertGreaterThanOrEqual(Theme.Spacing.tabBarClearance, 64)
        XCTAssertLessThanOrEqual(Theme.Spacing.tabBarClearance, 96)
    }
}
