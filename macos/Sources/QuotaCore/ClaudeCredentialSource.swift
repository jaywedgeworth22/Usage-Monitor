import Foundation
import Security

enum ClaudeCredentialSource {
    /// Never prompt, refresh, or mutate another app's login.  Metadata chooses
    /// the latest Claude Code item without assuming its account is the OS user.
    static func read() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnAttributes as String: true,
            kSecReturnPersistentRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]],
              let newest = items.max(by: {
                  ($0[kSecAttrModificationDate as String] as? Date ?? .distantPast)
                    < ($1[kSecAttrModificationDate as String] as? Date ?? .distantPast)
              }), let reference = newest[kSecValuePersistentRef as String] as? Data else { return nil }
        let dataQuery: [String: Any] = [
            kSecValuePersistentRef as String: reference,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
        ]
        var payload: CFTypeRef?
        guard SecItemCopyMatching(dataQuery as CFDictionary, &payload) == errSecSuccess,
              let data = payload as? Data, data.count <= 65_536 else { return nil }
        return data
    }
}
