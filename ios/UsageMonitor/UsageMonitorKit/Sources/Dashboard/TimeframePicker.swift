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
        ("Past 24 Hours",  .rolling(days: 1)),
        ("Past Week",      .rolling(days: 7)),
        ("Past 30 Days",   .rolling(days: 30)),
        ("Past 3 Months",  .rolling(days: 90)),
        ("Past 6 Months",  .rolling(days: 180)),
        ("All Time",       .rolling(days: 3650)),
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
                        Label(item.label, systemImage: selection == item.option ? "checkmark" : "")
                    }
                }
            }

            // Section 2: Calendar Months
            Section("Calendar Months") {
                ForEach(monthOptions, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        Label(option.displayLabel, systemImage: selection == option ? "checkmark" : "")
                    }
                }
            }

            // Section 3: Calendar Years
            Section("Calendar Years") {
                ForEach(yearOptions, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        Label(option.displayLabel, systemImage: selection == option ? "checkmark" : "")
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
        .accessibilityLabel("Time period filter")
        .accessibilityValue(selection.displayLabel)
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
