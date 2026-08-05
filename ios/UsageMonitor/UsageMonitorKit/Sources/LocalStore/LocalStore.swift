import Foundation

/// On-device money-truth store for **Usage Monitor Local**.
///
/// Schema authority: `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md` §2.2.1.
/// This target is a scaffold — PR-2 replaces the placeholder with GRDB + that exact DDL.
///
/// Isolation rules:
/// - Lives only in the Local app process (bundle `services.jays.usage.monitor.local`).
/// - Never write provider API key material here (Keychain only).
/// - Never share a database file with the remote client app group.
public protocol LocalStoring: Sendable {
    /// Schema / migration version currently applied (0 = empty scaffold).
    var schemaVersion: Int { get async }

    /// Opens (or creates) the store. Scaffold is a no-op success.
    func open() async throws

    /// Drops all local money data. Keys are not stored here.
    func wipeAll() async throws
}

/// In-memory scaffold used until GRDB lands. Safe for UI shell and tests.
public actor PlaceholderLocalStore: LocalStoring {
    public static let shared = PlaceholderLocalStore()

    private var opened = false
    public private(set) var schemaVersion: Int = 0

    public init() {}

    public func open() async throws {
        opened = true
        // v0 = scaffold only. PR-2 bumps to migration v1 and applies DDL.
        schemaVersion = 0
    }

    public func wipeAll() async throws {
        schemaVersion = 0
        opened = true
    }

    public var isOpen: Bool { opened }
}

/// Errors reserved for the real GRDB store (PR-2+).
public enum LocalStoreError: Error, Equatable, Sendable {
    case notOpen
    case migrationFailed(String)
    case unsupportedSchema(found: Int, expected: Int)
}
