import SwiftUI

/// Bottom scroll clearance for the floating glass tab bar.
///
/// The Client shell draws a custom capsule bar.  On iOS 26, Form / List /
/// ScrollView still park the last rows and section footers inside the soft
/// scroll-edge fade, so the end of every tab is only readable during
/// rubber-band overscroll.  Apply this once at the tab shell (and on the
/// Local system `TabView`) so every scrolling surface inherits it.
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
    /// Keep the last rows and footers readable above the glass tab bar.
    func tabBarScrollClearance() -> some View {
        modifier(TabBarScrollClearanceModifier())
    }
}
