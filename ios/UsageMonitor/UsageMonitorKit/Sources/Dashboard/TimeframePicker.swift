import SwiftUI

/// A grouped Menu-style picker that mirrors the web dashboard's <select> with
/// three <optgroup> sections:
///   Rolling Periods   — Past 24 Hours … All Time
///   Calendar Months   — current month + 12 prior (newest first)
///   Calendar Years    — current year + 2 prior
///
/// Usage:
///   TimeframePicker(selection: $selectedTimeframe)
///
/// The label shows the currently selected period's `displayLabel`. On iOS 26 /
/// visionOS the native Menu renders with smooth animation and full VoiceOver
/// support out of the box.
public struct TimeframePicker: View {
    @Binding public var selection: TimeframeOption

    private let rollingOptions: [(label: String, option: TimeframeOption)] = [
        ("Past 24 hours",  .rolling(days: 1)),
        ("Past 7 days",    .rolling(days: 7)),
        ("Past 30 days",   .rolling(days: 30)),
        ("Past 90 days",   .rolling(days: 90)),
        ("Past 180 days",  .rolling(days: 180)),
        ("Past 12 months", .rolling(days: 365)),
        ("All time",       .rolling(days: 3650)),
    ]

    private let monthOptions: [TimeframeOption]
    private let yearOptions: [TimeframeOption]

    public init(selection: Binding<TimeframeOption>) {
        self._selection = selection
        self.monthOptions = TimeframeOption.recentMonths(count: 13)
        self.yearOptions  = TimeframeOption.recentYears(count: 3)
    }

    public var body: some View {
        Menu {
            // Section 1: Rolling Periods
            Section("Rolling Periods") {
                ForEach(rollingOptions, id: \.option) { item in
                    Button {
                        selection = item.option
                    } label: {
                        // Never pass systemImage: "" — SF Symbols logs
                        // "No symbol named '' found" once per unselected row
                        // (×22 options × every menu re-render = log spam).
                        menuRowLabel(item.label, selected: selection == item.option)
                    }
                }
            }

            // Section 2: Calendar Months
            Section("Calendar Months") {
                ForEach(monthOptions, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        menuRowLabel(option.displayLabel, selected: selection == option)
                    }
                }
            }

            // Section 3: Calendar Years
            Section("Calendar Years") {
                ForEach(yearOptions, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        menuRowLabel(option.displayLabel, selected: selection == option)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(selection.displayLabel)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Image(systemName: "chevron.down")
                    .font(.caption)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(.primary)
        }
        .accessibilityLabel("Chart range")
        .accessibilityValue(selection.displayLabel)
        .accessibilityHint("Charts and usage history only. Budgets stay month-to-date.")
    }

    @ViewBuilder
    private func menuRowLabel(_ title: String, selected: Bool) -> some View {
        if selected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }
}

// MARK: - ForEach conformance helper
extension TimeframeOption: Identifiable {
    public var id: String {
        switch self {
        case .rolling(let d):              return "rolling:\(d)"
        case .calendarMonth(let y, let m): return "month:\(y)-\(m)"
        case .calendarYear(let y):         return "year:\(y)"
        }
    }
}

#if DEBUG
#Preview("TimeframePicker") {
    @Previewable @State var selection: TimeframeOption = .currentMonth
    return TimeframePicker(selection: $selection)
        .padding()
}
#endif
