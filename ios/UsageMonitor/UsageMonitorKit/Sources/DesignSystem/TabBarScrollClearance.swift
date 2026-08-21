import SwiftUI

/// Form/List last-footer clearance for the floating glass tab bar.
///
/// The Client shell draws a custom capsule bar via `safeAreaBar` /
/// `safeAreaInset`.  On iOS 26, `Form` still parks the last section footer
/// inside the soft scroll-edge fade, so the About blurb is only readable
/// during rubber-band overscroll and vanishes when the scroll settles.
/// Apply this to tab-root Forms so that last footer stays above the bar.
public struct TabBarScrollClearanceModifier: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .contentMargins(.bottom, Theme.Spacing.tabBarClearance, for: .scrollContent)
                .scrollEdgeEffectHidden(true, for: .bottom)
        } else {
            content
                .contentMargins(.bottom, Theme.Spacing.tabBarClearance, for: .scrollContent)
        }
    }
}

public extension View {
    /// Keep the last Form/List footer readable above the glass tab bar.
    func tabBarScrollClearance() -> some View {
        modifier(TabBarScrollClearanceModifier())
    }
}
