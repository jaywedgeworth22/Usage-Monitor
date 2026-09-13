import Foundation
import Security

enum ClaudeCredentialSource {
    private static let worker = DispatchQueue(label: "com.jays.usage-monitor.claude-keychain")
    private static let activeRead = DispatchSemaphore(value: 1)
    private static let timeout: DispatchTimeInterval = .seconds(3)

    /// Never prompt, refresh, or mutate another app's login.  Metadata chooses
    /// the latest Claude Code item without assuming its account is the OS user.
    static func read() async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            guard activeRead.wait(timeout: .now()) == .success else { continuation.resume(returning: nil); return }
            let gate = KeychainReadGate(continuation)
            worker.async {
                defer { activeRead.signal() }
                gate.finish(readSynchronously())
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                gate.finish(nil)
            }
        }
    }

    /// Bounds injected or future asynchronous keychain adapters as well as
    /// the production synchronous Security call.
    static func boundedRead(_ operation: @escaping @Sendable () async -> Data?) async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            let gate = KeychainReadGate(continuation)
            Task.detached(priority: .utility) { gate.finish(await operation()) }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                gate.finish(nil)
            }
        }
    }

    private static func readSynchronously() -> Data? {
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

/// Resumes the async caller exactly once when the Security framework returns,
/// or when its bounded wait expires.  A timed-out Security call may remain
/// stuck in the serial worker, but it cannot block this refresh task forever.
private final class KeychainReadGate: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let continuation: CheckedContinuation<Data?, Never>

    init(_ continuation: CheckedContinuation<Data?, Never>) {
        self.continuation = continuation
    }

    func finish(_ data: Data?) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        continuation.resume(returning: data)
    }
}
