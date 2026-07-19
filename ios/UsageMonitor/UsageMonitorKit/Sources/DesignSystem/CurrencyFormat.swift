import Foundation

/// Currency / percent formatting shared by the app and the widget so both
/// render money identically. USD is the monitor's canonical reporting
/// currency (see budget-status.ts — non-USD is excluded from budget math).
public enum CurrencyFormat {
    /// `$1,234.56` — full precision, for detail surfaces.
    public static func usd(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// Compact money for tiles/widgets: `$1.2K`, `$948`, `$4.16`.
    public static func compactUSD(_ value: Double) -> String {
        let magnitude = abs(value)
        if magnitude >= 1_000 {
            return value.formatted(
                .currency(code: "USD")
                    .notation(.compactName)
                    .precision(.fractionLength(0...1))
            )
        }
        if magnitude >= 100 {
            return value.formatted(.currency(code: "USD").precision(.fractionLength(0)))
        }
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// `48%` from a 0...1 ratio. Clamps nothing — callers decide.
    public static func percent(_ ratio: Double) -> String {
        ratio.formatted(.percent.precision(.fractionLength(0)))
    }
}
