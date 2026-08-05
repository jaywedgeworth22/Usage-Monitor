import XCTest
@testable import LocalStore

final class LocalStoreScaffoldTests: XCTestCase {
    func testPlaceholderOpensAtSchemaZero() async throws {
        let store = PlaceholderLocalStore()
        try await store.open()
        let version = await store.schemaVersion
        XCTAssertEqual(version, 0)
        let isOpen = await store.isOpen
        XCTAssertTrue(isOpen)
    }

    func testWipeKeepsScaffoldVersion() async throws {
        let store = PlaceholderLocalStore()
        try await store.open()
        try await store.wipeAll()
        let version = await store.schemaVersion
        XCTAssertEqual(version, 0)
    }
}
