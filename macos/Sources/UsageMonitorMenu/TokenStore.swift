import Foundation
import Security

/// The monitor token is scoped to its server URL and never stored in preferences.
enum TokenStore {
    private static let service = "com.jays.usage-monitor.mac.read-token"

    static func read(server: String) -> String? {
        var query = base(server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, server: String) throws {
        let query = base(server)
        let attributes = [kSecValueData as String: Data(token.utf8)] as [String: Any]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query.merging(attributes) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw Failure.write }
        } else if status != errSecSuccess {
            throw Failure.write
        }
    }

    static func delete(server: String) throws {
        let status = SecItemDelete(base(server) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.write }
    }

    private static func base(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: server]
    }

    enum Failure: LocalizedError {
        case write
        var errorDescription: String? { "Keychain could not save the connection.  Unlock your login Keychain and try again." }
    }
}
