import SwiftUI

/// A centered error state with a title, message, and (when the failure is
/// retryable) a "Try again" button. Feature view-models pass the mapped title
/// and message from their typed error; whether to offer retry is the caller's
/// decision (e.g. `APIError.isRetryable`).
public struct ErrorState: View {
    private let systemImage: String
    private let title: String
    private let message: String
    private let retryTitle: String?
    private let retry: (() -> Void)?

    public init(
        systemImage: String = "exclamationmark.triangle.fill",
        title: String,
        message: String,
        retryTitle: String? = "Try again",
        retry: (() -> Void)? = nil
    ) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.retryTitle = retryTitle
        self.retry = retry
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Image(systemName: systemImage)
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(Theme.Colors.warning)
                .frame(width: 72, height: 72)
                .background(Theme.Colors.warning.opacity(0.14), in: Circle())

            VStack(spacing: Theme.Spacing.sm) {
                Text(title)
                    .font(Theme.Typography.title)
                    .foregroundStyle(Theme.Colors.primaryText)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
            }

            if let retryTitle, let retry {
                Button(action: retry) {
                    Label(retryTitle, systemImage: "arrow.clockwise")
                        .font(Theme.Typography.callout.weight(.semibold))
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, Theme.Spacing.sm)
                }
                .buttonStyle(.bordered)
                .tint(Theme.Colors.accent)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    ErrorState(
        title: "You're offline",
        message: "Check your internet connection and pull to refresh.",
        retry: {}
    )
    .frame(maxHeight: .infinity)
    .background(Theme.Colors.background)
}
