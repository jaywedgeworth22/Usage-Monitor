import SwiftUI
import AppCore
import DesignSystem

/// PLACEHOLDER — owned by the **AppLock** lane. Replace the body with a real
/// `LocalAuthentication` (Face ID / Touch ID / passcode) gate.
///
/// Contract (see ARCHITECTURE-CONTRACT.md):
///   - Keep the public entry point `AppLockGate` wrapping arbitrary content:
///     the app target wraps `RootView` in it. Its signature must stay
///     `AppLockGate { <content> }`.
///   - Read `@Environment(AppEnvironment.self)`; honor
///     `env.settings.appLockEnabled`. When enabled, obscure `content` and
///     require `LAContext.evaluatePolicy` before revealing it; re-lock on
///     `scenePhase == .background`. When disabled, render `content` directly.
///   - The `NSFaceIDUsageDescription` Info.plist key is already present.
///
/// This starter implementation is a pass-through so the app compiles and runs
/// unlocked until the lane implements the real gate.
public struct AppLockGate<Content: View>: View {
    @Environment(AppEnvironment.self) private var env
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
    }
}
