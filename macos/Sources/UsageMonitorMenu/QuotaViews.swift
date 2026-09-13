import AppKit
import QuotaCore
import SwiftUI

private enum Palette {
    static let ink = Color(red: 0.12, green: 0.17, blue: 0.23)
    static let accent = Color(red: 0.03, green: 0.45, blue: 0.43)
    static let background = Color(red: 0.96, green: 0.97, blue: 0.97)
    static let warning = Color(red: 0.66, green: 0.36, blue: 0.02)
    static let danger = Color(red: 0.75, green: 0.20, blue: 0.23)
}

struct MonitorDashboard: View {
    @ObservedObject var model: MonitorModel
    var openSettings: () -> Void
    @State private var selected = "all"
    @State private var query = ""

    private var visibleSections: [QuotaPlatformSection] {
        model.sections.filter { section in
            (selected == "all" || selected == section.providerKey)
                && (query.isEmpty || section.providerLabel.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        summary
                        if let error = model.serverError {
                            Label("Server: \(error)  Last readings may be outdated.", systemImage: "exclamationmark.triangle")
                                .font(.callout).foregroundStyle(Palette.warning)
                        }
                        if !model.localEnabled && !model.serverEnabled {
                            ContentUnavailableView("Connect a Quota Source", systemImage: "link",
                                                   description: Text("Enable local agent readings or connect your Usage Monitor server in Settings."))
                        }
                        HStack {
                            Text(selected == "all" ? "Subscription Quotas" : visibleSections.first?.providerLabel ?? "Subscription Quotas")
                                .font(.title3.bold())
                            Spacer()
                            Text("Percent remaining").font(.caption).foregroundStyle(.secondary)
                        }
                        LazyVGrid(columns: selected == "all" ? [GridItem(.adaptive(minimum: 290), alignment: .top)] : [GridItem(.flexible())], alignment: .leading, spacing: 16) {
                            ForEach(visibleSections, id: \.providerKey) { section in
                                PlatformCard(section: section, now: model.now, issue: model.issues[section.providerKey], compact: false, wide: selected != "all")
                            }
                        }
                        Text("Each window is an independent cap.  A model offered through Antigravity uses the Antigravity subscription.  Unreported limits stay unavailable.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(26)
                }
                .background(Palette.background)
                .id(selected + query)
            }
        }
        .foregroundStyle(Palette.ink)
        .tint(Palette.accent)
        .preferredColorScheme(.light)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 9) {
                Image(systemName: "gauge.with.dots.needle.50percent").font(.title2).foregroundStyle(Palette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage Monitor").font(.headline)
                    Text("AGENT SUBSCRIPTIONS").font(.system(size: 8, weight: .semibold, design: .rounded)).tracking(1.1).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, 16).padding(.top, 24)
            List(selection: $selected) {
                Label("All Platforms", systemImage: "square.grid.2x2").tag("all")
                Section("Platforms") {
                    ForEach(model.sections, id: \.providerKey) { section in
                        HStack(spacing: 8) {
                            Circle().fill(section.hasFreshReport && model.issues[section.providerKey] == nil ? Palette.accent : Color.gray.opacity(0.4)).frame(width: 6, height: 6)
                            Text(section.providerLabel)
                            Spacer()
                            if section.providerKey != "google-antigravity", model.issues[section.providerKey] == nil, let remaining = section.windows.filter(\.isFresh).compactMap(\.remainingPercent).min() {
                                Text("\(Int(remaining.rounded()))%").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }.tag(section.providerKey)
                    }
                }
            }.listStyle(.sidebar).scrollContentBackground(.hidden)
            VStack(alignment: .leading, spacing: 10) {
                Label(model.localEnabled ? "Local Mac readings" : "Local readings off", systemImage: "desktopcomputer")
                    .font(.caption).foregroundStyle(.secondary)
                Button {
                    NSWorkspace.shared.open(URL(string: "https://usage.jays.services")!)
                } label: { Label("Web Dashboard", systemImage: "arrow.up.right.square") }
                    .buttonStyle(.plain).font(.caption)
                Button(action: openSettings) { Label("Settings", systemImage: "gearshape") }
                    .buttonStyle(.plain)
            }.padding(18)
        }
        .frame(width: 208)
        .background(Color.white)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Agent Quotas").font(.system(size: 28, weight: .bold, design: .rounded))
                Text("Your subscriptions, at a glance.").font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            TextField("Find a platform", text: $query).textFieldStyle(.roundedBorder).frame(width: 155)
                .accessibilityLabel("Find a platform")
            Button { model.refresh() } label: {
                Label(model.isRefreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
            }.disabled(model.isRefreshing)
        }.padding(26).background(Color.white)
    }

    private var summary: some View {
        HStack(spacing: 12) {
            SummaryTile(label: "Reporting", value: "\(model.reportingCount) / \(model.sections.count)", symbol: "antenna.radiowaves.left.and.right", detail: "Platforms with current readings")
            SummaryTile(label: "Near Cap", value: "\(model.nearCapCount)", symbol: "gauge.with.dots.needle.100percent", detail: "Windows at 20% or less")
            SummaryTile(label: "Next Reset", value: model.nextReset.map { $0.formatted(date: .omitted, time: .shortened) } ?? "—", symbol: "clock", detail: model.nextReset.map { $0.formatted(.dateTime.month(.abbreviated).day()) } ?? "No current reset reported")
        }
    }
}

private struct SummaryTile: View {
    let label: String
    let value: String
    let symbol: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(label, systemImage: symbol).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 25, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
        .padding(16).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.black.opacity(0.06)))
    }
}

struct PlatformCard: View {
    let section: QuotaPlatformSection
    let now: Date
    let issue: String?
    let compact: Bool
    var wide = false
    @State private var expanded = false

    private var displayedWindows: [QuotaWindowSnapshot] {
        expanded ? section.windows : Array(section.windows.prefix(4))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 16) {
            HStack(spacing: 10) {
                Text(monogram).font(.system(size: compact ? 12 : 15, weight: .bold, design: .rounded))
                    .frame(width: compact ? 28 : 36, height: compact ? 28 : 36)
                    .background(Palette.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
                    .foregroundStyle(Palette.accent).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.providerLabel).font(.headline)
                    if section.via == "antigravity" {
                        Text("Antigravity subscription").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !section.windows.isEmpty {
                    Text(issue == nil && section.hasFreshReport ? "LIVE" : "LAST REPORT")
                        .font(.system(size: 8, weight: .bold)).tracking(0.7)
                        .foregroundStyle(issue == nil && section.hasFreshReport ? Palette.accent : Palette.warning)
                }
            }
            if section.windows.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Quota unavailable").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                    Text(issue ?? "No subscription quota source connected.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if wide && displayedWindows.count > 1 {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 22) {
                        ForEach(displayedWindows, id: \.window.id) { snapshot in
                            QuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil, compact: compact)
                                .padding(12)
                                .background(Palette.background, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                } else {
                    ForEach(Array(displayedWindows.enumerated()), id: \.offset) { index, snapshot in
                        if index > 0 { Divider() }
                        QuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil, compact: compact)
                    }
                }
                if section.windows.count > 4 {
                    Button(expanded ? "Show Less" : "Show All \(section.windows.count) Windows") { expanded.toggle() }
                        .buttonStyle(.plain).font(.caption.weight(.medium)).foregroundStyle(Palette.accent)
                }
                if let issue {
                    Label(issue, systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(Palette.warning).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(compact ? 14 : 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.black.opacity(0.07)))
    }

    private var monogram: String {
        switch section.providerKey {
        case "anthropic": return "Cl"
        case "openai": return "Cx"
        case "google-antigravity": return "Ag"
        case "github-copilot": return "Co"
        default: return String(section.providerLabel.prefix(2))
        }
    }
}

private struct QuotaRow: View {
    let snapshot: QuotaWindowSnapshot
    let now: Date
    let sourceFailed: Bool
    let compact: Bool
    private var tint: Color {
        if !snapshot.isFresh || sourceFailed || snapshot.remainingPercent == nil { return .secondary }
        if snapshot.status == .exhausted { return Palette.danger }
        if (snapshot.remainingPercent ?? 100) <= 20 { return Palette.warning }
        return Palette.accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(snapshot.window.label).font(.system(size: compact ? 11 : 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 10)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(snapshot.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—")
                        .font(.system(size: compact ? 18 : 24, weight: .semibold, design: .rounded))
                        .monospacedDigit().foregroundStyle(tint)
                    Text(snapshot.remainingPercent == nil ? "unavailable" : snapshot.isFresh && !sourceFailed ? "remaining" : "last reported")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
            }
            if let remaining = snapshot.remainingPercent {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.black.opacity(0.06))
                        Capsule().fill(tint).frame(width: geometry.size.width * remaining / 100)
                    }
                }.frame(height: 5)
                .accessibilityLabel("\(Int(remaining.rounded())) percent remaining")
            }
            if let remaining = snapshot.window.absoluteRemaining, let limit = snapshot.window.absoluteLimit,
               remaining.isFinite, limit.isFinite, remaining >= 0, limit > 0, let unit = snapshot.window.quotaUnit {
                Text("\(remaining.formatted(.number.precision(.fractionLength(0...1)))) of \(limit.formatted(.number.precision(.fractionLength(0...1)))) \(unit) remaining")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Image(systemName: "clock.arrow.circlepath").accessibilityHidden(true)
                Text(resetCountdown(snapshot.resetAt, now: now))
            }.font(.caption2).foregroundStyle(.secondary)
            if let reset = snapshot.resetAt, !compact {
                Text(reset.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute().timeZone()))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
            if !compact {
                HStack {
                    Text(snapshot.observedAt.map { "Updated \($0.formatted(date: .omitted, time: .shortened))" } ?? "Update time unavailable")
                    Spacer()
                    if snapshot.observedAt == nil { Text("Not reported") }
                    else if snapshot.isStale { Text("Stale").foregroundStyle(Palette.warning) }
                    else if let source = snapshot.window.source { Text(source).lineLimit(1) }
                }.font(.system(size: 9)).foregroundStyle(.tertiary)
            }
        }.accessibilityElement(children: .combine)
    }
}

struct QuotaPopover: View {
    @ObservedObject var model: MonitorModel
    var openMonitor: () -> Void
    var openSettings: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Usage Monitor").font(.headline)
                    Text("\(model.reportingCount) platforms reporting").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.isRefreshing).help("Refresh Quotas").accessibilityLabel("Refresh Quotas")
                Button(action: openSettings) { Image(systemName: "gearshape") }.help("Settings").accessibilityLabel("Settings")
            }.padding(16)
            Divider()
            ScrollView {
                VStack(spacing: 10) {
                    if model.isRefreshing { ProgressView("Refreshing quotas…").font(.caption).padding(4) }
                    if let error = model.serverError { Text(error).font(.caption).foregroundStyle(Palette.warning) }
                    ForEach(model.sections.sorted { !$0.windows.isEmpty && $1.windows.isEmpty }, id: \.providerKey) { section in
                        PlatformCard(section: section, now: model.now, issue: model.issues[section.providerKey], compact: true)
                    }
                }.padding(12)
            }.background(Palette.background)
            Divider()
            HStack {
                Button("Open Monitor", action: openMonitor).buttonStyle(.borderedProminent)
                Spacer()
                Menu {
                    Picker("Show In", selection: $model.displayMode) {
                        ForEach(DisplayMode.allCases) { Text($0.title).tag($0) }
                    }
                    Divider()
                    Button("Quit Usage Monitor") { NSApp.terminate(nil) }
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).frame(width: 24)
            }.padding(14)
        }
        .frame(width: 410, height: 600)
        .tint(Palette.accent).preferredColorScheme(.light)
    }
}

struct MonitorSettings: View {
    @ObservedObject var model: MonitorModel
    @State private var local = true
    @State private var server = false
    @State private var endpoint = ""
    @State private var token = ""
    @State private var message: String?
    @State private var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Usage Monitor Settings").font(.title2.bold())
            GroupBox("Appearance") {
                Picker("Show In", selection: $model.displayMode) {
                    ForEach(DisplayMode.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).padding(10)
            }
            GroupBox("Quota Sources") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Read Agent Quotas on This Mac", isOn: $local)
                    Text("Uses existing Claude, Codex, Antigravity, Cursor, Grok, MiniMax, Kimi, and Gemini CLI sign-ins.  Other platforms can report through your server.")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Toggle("Connect Usage Monitor Server", isOn: $server)
                    TextField("Quota Endpoint", text: $endpoint).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Quota Endpoint").disabled(!server)
                    SecureField(model.hasSavedToken ? "Token saved · enter to replace" : "Usage Monitor read token", text: $token)
                        .textFieldStyle(.roundedBorder).disabled(!server).accessibilityLabel("Usage Monitor read token")
                    Text("The read token stays in this Mac’s Keychain.  Refreshes every 5 minutes while the app is running.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(10)
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(isError ? Palette.danger : Palette.accent)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if model.hasSavedToken {
                    Button("Forget Server Token", role: .destructive) {
                        do { try model.forgetServer(); server = false; token = ""; message = "Server token removed."; isError = false }
                        catch { message = error.localizedDescription; isError = true }
                    }
                }
                Spacer()
                Button("Save & Refresh") {
                    do {
                        try model.saveConnection(local: local, server: server, endpoint: endpoint, token: token)
                        token = ""; message = "Settings saved."; isError = false
                    } catch { message = error.localizedDescription; isError = true }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
            Spacer(minLength: 0)
        }
        .padding(24).frame(width: 580, height: 510).tint(Palette.accent).preferredColorScheme(.light)
        .onAppear { local = model.localEnabled; server = model.serverEnabled; endpoint = model.endpoint }
    }
}
