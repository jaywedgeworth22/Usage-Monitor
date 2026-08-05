import Foundation
import Security

/// Keychain storage for provider API keys (Local Usage Monitor only).
/// Never write secrets into SQLite / LocalStore.
public struct ProviderCredentials: Sendable, Equatable {
    public var apiKey: String
    public init(apiKey: String) { self.apiKey = apiKey }
}

public protocol ProviderSecretStoring: Sendable {
    func save(accountId: String, credentials: ProviderCredentials) throws
    func load(accountId: String) throws -> ProviderCredentials?
    func delete(accountId: String) throws
}

public struct ProviderKeychainStore: ProviderSecretStoring, Sendable {
    public static let shared = ProviderKeychainStore()

    private let service = "services.jays.local.usage.monitor.provider-keys"

    public init() {}

    public func save(accountId: String, credentials: ProviderCredentials) throws {
        let data = Data(credentials.apiKey.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw ProviderKeychainError.osStatus(status)
        }
    }

    public func load(accountId: String) throws -> ProviderCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data,
              let key = String(data: data, encoding: .utf8) else {
            throw ProviderKeychainError.osStatus(status)
        }
        return ProviderCredentials(apiKey: key)
    }

    public func delete(accountId: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProviderKeychainError.osStatus(status)
        }
    }
}

public enum ProviderKeychainError: Error, Equatable, Sendable {
    case osStatus(OSStatus)
}
