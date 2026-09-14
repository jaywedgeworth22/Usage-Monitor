import Foundation
import LocalAuthentication
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
        if let data = readViaSecurityCLI() {
            return data
        }

        let context = LAContext()
        context.interactionNotAllowed = true

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationContext as String: context,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]],
              let newest = items.max(by: {
                  ($0[kSecAttrModificationDate as String] as? Date ?? .distantPast)
                    < ($1[kSecAttrModificationDate as String] as? Date ?? .distantPast)
              }) else { return nil }

        var dataQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        if let account = newest[kSecAttrAccount as String] {
            dataQuery[kSecAttrAccount as String] = account
        }
        var payload: CFTypeRef?
        guard SecItemCopyMatching(dataQuery as CFDictionary, &payload) == errSecSuccess,
              let data = payload as? Data, data.count <= 1_048_576 else { return nil }
        return data
    }

    private static func readViaSecurityCLI() -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
        process.environment = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        let reader = output.fileHandleForReading
        defer {
            // Ensure the child process is reaped and pipes are closed even on
            // early returns so we never leak a zombie or file descriptor.
            if process.isRunning { process.terminate() }
            try? output.fileHandleForWriting.close()
            try? reader.close()
            if process.isRunning { process.waitUntilExit() }
        }
        do {
            try process.run()
            try? output.fileHandleForWriting.close()
            let descriptor = reader.fileDescriptor
            _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
            let deadline = ProcessInfo.processInfo.systemUptime + 3.0
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                if ProcessInfo.processInfo.systemUptime >= deadline { return nil }
                let count = Darwin.read(descriptor, &buffer, buffer.count)
                if count > 0 {
                    guard data.count + count <= 1_048_576 else { return nil }
                    data.append(contentsOf: buffer.prefix(count))
                    continue
                }
                if count < 0 && errno == EAGAIN {
                    if !process.isRunning {
                        while true {
                            let finalCount = Darwin.read(descriptor, &buffer, buffer.count)
                            if finalCount > 0 { data.append(contentsOf: buffer.prefix(finalCount)) }
                            else { break }
                        }
                        break
                    }
                    usleep(5000)
                    continue
                }
                if count == 0 { break }
            }
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            if let string = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               let trimmed = string.data(using: .utf8) {
                // macOS 26+ may output a hex-encoded string when the value
                // contains non-ASCII bytes.  Detect and decode it.
                if let decoded = Self.decodeHexString(trimmed) {
                    return decoded
                }
                return trimmed
            }
            return data
        } catch {
            return nil
        }
    }

    /// Returns decoded `Data` when the input is a pure hex string (pairs of
    /// `[0-9a-fA-F]`, optionally whitespace-separated).  Returns `nil` for
    /// anything that doesn't look like hex output, so the caller falls through
    /// to treating the data as-is.
    private static func decodeHexString(_ data: Data) -> Data? {
        guard let raw = String(data: data, encoding: .utf8) else { return nil }
        let hex = raw.filter { !$0.isWhitespace }
        // Must be even-length and entirely hex digits.
        guard hex.count >= 2, hex.count.isMultiple(of: 2),
              hex.allSatisfy({ $0.isHexDigit }) else { return nil }
        // Only decode if it looks like hex-encoded JSON (starts with 7b = '{').
        guard hex.hasPrefix("7b") || hex.hasPrefix("7B") else { return nil }
        var decoded = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            decoded.append(byte)
            index = next
        }
        return decoded
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
