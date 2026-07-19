import Foundation
import UserNotifications
import Models

/// PLACEHOLDER — owned by the **PushScaffold** lane. A scaffold for
/// `UserNotifications` + (later) APNs registration so budget/alert
/// notifications can be delivered. Depends only on `AppCore` + `Models`.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep `PushScaffold` as the public entry point the app calls at launch.
///   - `requestAuthorization()` asks for alert/badge/sound permission.
///   - `registerForRemoteNotifications()` (to be implemented) triggers APNs
///     registration; the app forwards the device token here.
///   - Local-notification scheduling from `[ProviderAlert]` can start here
///     before any server push exists (`UIBackgroundModes: remote-notification`
///     and `BGTaskSchedulerPermittedIdentifiers` are already declared).
public enum PushScaffold {
    /// Request notification authorization. Returns whether it was granted.
    /// Safe no-network call — the lane extends this with categories/actions.
    @discardableResult
    public static func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }

    /// Placeholder for APNs device-token intake. The lane wires this to the
    /// `UIApplicationDelegate` callback and (eventually) the server.
    public static func setAPNsDeviceToken(_ token: Data) {
        // Intentionally empty until remote push is implemented.
    }
}
