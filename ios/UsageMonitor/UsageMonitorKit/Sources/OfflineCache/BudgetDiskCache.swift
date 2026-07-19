import Foundation
import Models

/// Disk persistence for the last successful budget response, enabling an
/// offline-first first paint. Owned by the **OfflineCache** lane — this is a
/// working starter the lane may extend (staleness policy, multi-entry history,
/// encryption at rest, etc.).
///
/// Intentionally free of any `AppCore` dependency (see the target's layering):
/// it operates purely on `Models`. The app target adapts it to
/// `AppCore.BudgetSnapshotSink`.
public struct BudgetDiskCache {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// - Parameter directory: defaults to the app's Caches directory. The app
    ///   group container can be passed to share the cache with the widget.
    public init(directory: URL? = nil, fileName: String = "budget-status-cache.json") {
        let base = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        self.fileURL = base.appendingPathComponent(fileName)
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    /// Persist the response atomically. Swallows I/O errors — caching is a
    /// best-effort side effect, never a hard failure.
    public func save(_ response: BudgetStatusResponse) {
        guard let data = try? encoder.encode(response) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// The most recently cached response, or `nil` when none exists / is
    /// unreadable.
    public func load() -> BudgetStatusResponse? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? decoder.decode(BudgetStatusResponse.self, from: data)
    }

    /// Remove the cache (e.g. on sign-out / token change).
    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
