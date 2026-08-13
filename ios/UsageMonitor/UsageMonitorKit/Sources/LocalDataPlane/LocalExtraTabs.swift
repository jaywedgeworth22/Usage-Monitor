import SwiftUI
import DesignSystem
import LocalStore
import LocalBudget
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Alerts

struct LocalAlertsTab: View {
    @Bindable var model: LocalAppModel
    var openProvider: (String) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if model.alerts.isEmpty {
                    ContentUnavailableView(
                        "All Clear",
                        systemImage: "checkmark.seal.fill",
                        description: Text("Budget and fetch issues show up here. Phone-local rules only — no fleet Slack/PagerDuty.")
                    )
                } else {
                    List {
                        Section {
                            ForEach(model.alerts) { alert in
                                Button {
                                    if let id = alert.providerId {
                                        openProvider(id)
                                    }
                                } label: {
                                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                                        Image(systemName: symbol(for: alert.severity))
                                            .foregroundStyle(color(for: alert.severity))
                                            .frame(width: 28)
                                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                                            Text(alert.title)
                                                .font(Theme.Typography.callout.weight(.semibold))
                                                .foregroundStyle(Theme.Colors.primaryText)
                                            Text(alert.message)
                                                .font(Theme.Typography.caption)
                                                .foregroundStyle(Theme.Colors.secondaryText)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                        } footer: {
                            Text("\(model.alerts.count) open · derived on-device from budgets and poll errors")
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Alerts")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { try? await model.reload() }
        }
    }

    private func symbol(for severity: LocalAlertItem.Severity) -> String {
        switch severity {
        case .critical: return "exclamationmark.octagon.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        }
    }

    private func color(for severity: LocalAlertItem.Severity) -> Color {
        switch severity {
        case .critical: return Theme.Colors.danger
        case .warning: return Theme.Colors.warning
        case .info: return Theme.Colors.accent
        }
    }
}

// MARK: - Projects

struct LocalProjectsTab: View {
    @Bindable var model: LocalAppModel
    @State private var showAdd = false
    @State private var editProject: LocalProject?
    @State private var spentByProject: [String: Double] = [:]

    var body: some View {
        NavigationStack {
            List {
                if model.projects.isEmpty {
                    ContentUnavailableView(
                        "No Projects",
                        systemImage: "folder",
                        description: Text("Tag spend with project budgets (direct charges only). Residual % allocation stays on the web.")
                    )
                } else {
                    Section {
                        let totalSpent = spentByProject.values.reduce(0, +)
                        let budgeted = model.projects.compactMap(\.monthlyBudgetUsd).filter { $0 > 0 }
                        let totalBudget = budgeted.reduce(0, +)
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text("All Projects")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                            Text(CurrencyFormat.usd(totalSpent))
                                .font(Theme.Typography.hero)
                                .monospacedDigit()
                            if totalBudget > 0 {
                                LabeledBudgetMeter(
                                    title: "Budget",
                                    detail: "\(CurrencyFormat.usd(totalSpent)) of \(CurrencyFormat.usd(totalBudget))",
                                    fraction: totalSpent / totalBudget,
                                    status: meterStatus(spent: totalSpent, budget: totalBudget)
                                )
                            } else {
                                Text("no budget set")
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                            Text("\(model.projects.count) project\(model.projects.count == 1 ? "" : "s") · direct charges only")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.tertiaryText)
                        }
                        .padding(.vertical, Theme.Spacing.xxs)
                    }

                    ForEach(model.projects) { project in
                        Button {
                            editProject = project
                        } label: {
                            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                HStack {
                                    Text(project.name)
                                        .font(Theme.Typography.callout.weight(.semibold))
                                        .foregroundStyle(Theme.Colors.primaryText)
                                    Spacer()
                                    Text(CurrencyFormat.usd(spentByProject[project.id] ?? 0))
                                        .font(Theme.Typography.callout.weight(.semibold))
                                        .monospacedDigit()
                                }
                                if let budget = project.monthlyBudgetUsd, budget > 0 {
                                    let spent = spentByProject[project.id] ?? 0
                                    LabeledBudgetMeter(
                                        title: "Budget",
                                        detail: "\(CurrencyFormat.usd(spent)) of \(CurrencyFormat.usd(budget))",
                                        fraction: spent / budget,
                                        status: meterStatus(spent: spent, budget: budget)
                                    )
                                } else {
                                    Text("no budget set")
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            }
                            .padding(.vertical, Theme.Spacing.xxs)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { try? await model.deleteProject(id: project.id) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAdd = true } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAdd) {
                ProjectEditorSheet(model: model, existing: nil)
            }
            .sheet(item: $editProject) { project in
                ProjectEditorSheet(model: model, existing: project)
            }
            .task { await refreshSpend() }
            .refreshable {
                try? await model.reload()
                await refreshSpend()
            }
        }
    }

    private func refreshSpend() async {
        var map: [String: Double] = [:]
        for p in model.projects {
            map[p.id] = (try? await model.projectSpentUsd(projectId: p.id)) ?? 0
        }
        spentByProject = map
    }

    private func meterStatus(spent: Double, budget: Double) -> Theme.SemanticStatus {
        let r = spent / budget
        if r >= 1 { return .danger }
        if r >= 0.8 { return .warning }
        return .ok
    }
}

private struct ProjectEditorSheet: View {
    @Bindable var model: LocalAppModel
    let existing: LocalProject?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var budget = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Name", text: $name)
                    TextField("Description", text: $description, axis: .vertical)
                    HStack {
                        Text("$")
                        TextField("Monthly budget (optional)", text: $budget)
                            .keyboardType(.decimalPad)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(Theme.Colors.danger)
                }
            }
            .navigationTitle(existing == nil ? "Add project" : "Edit project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                if let existing {
                    name = existing.name
                    description = existing.description ?? ""
                    if let b = existing.monthlyBudgetUsd {
                        budget = b.formatted(.number.precision(.fractionLength(0...2)))
                    }
                }
            }
        }
    }

    private func save() async {
        let trimmedBudget = budget.trimmingCharacters(in: .whitespacesAndNewlines)
        let budgetValue: Double? = trimmedBudget.isEmpty ? nil : Double(trimmedBudget)
        do {
            try await model.upsertProject(
                name: name,
                description: description.isEmpty ? nil : description,
                monthlyBudgetUsd: budgetValue,
                id: existing?.id
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Export share

struct LocalExportButton: View {
    @Bindable var model: LocalAppModel
    @State private var shareURL: URL?
    @State private var isExporting = false
    @State private var error: String?

    var body: some View {
        Button {
            Task { await export() }
        } label: {
            if isExporting {
                ProgressView()
            } else {
                Label("Export data (no secrets)", systemImage: "square.and.arrow.up")
            }
        }
        .disabled(isExporting)
        .sheet(isPresented: Binding(
            get: { shareURL != nil },
            set: { if !$0 { shareURL = nil } }
        )) {
            if let shareURL {
                ShareSheet(items: [shareURL])
            }
        }
        if let error {
            Text(error)
                .font(.caption)
                .foregroundStyle(Theme.Colors.danger)
        }
    }

    private func export() async {
        isExporting = true
        error = nil
        defer { isExporting = false }
        do {
            let data = try await model.exportPackageJSON()
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("usage-monitor-local-export-\(Int(Date().timeIntervalSince1970)).json")
            try data.write(to: url, options: .atomic)
            shareURL = url
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct LocalImportButton: View {
    @Bindable var model: LocalAppModel
    @State private var showImporter = false
    @State private var mode: LocalImportMode = .merge
    @State private var message: String?
    @State private var isImporting = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Picker("Import mode", selection: $mode) {
                Text("Merge (skip existing)").tag(LocalImportMode.merge)
                Text("Replace all data").tag(LocalImportMode.replace)
            }
            Button {
                showImporter = true
            } label: {
                if isImporting {
                    ProgressView()
                } else {
                    Label("Import export package…", systemImage: "square.and.arrow.down")
                }
            }
            .disabled(isImporting)
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [.json],
            allowsMultipleSelection: false
        ) { result in
            Task { await handle(result) }
        }
    }

    private func handle(_ result: Result<[URL], Error>) async {
        isImporting = true
        defer { isImporting = false }
        do {
            let urls = try result.get()
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let r = try await model.importPackage(data: data, mode: mode)
            message =
                "Imported \(r.providers) providers, \(r.subscriptions) fees, \(r.charges) charges, \(r.snapshots) snapshots"
                + (r.skipped > 0 ? " (\(r.skipped) skipped)" : "")
                + ". Re-enter API keys."
        } catch {
            message = error.localizedDescription
        }
    }
}

struct LocalKeysImportButton: View {
    @Bindable var model: LocalAppModel
    @State private var showImporter = false
    @State private var pendingBundle: Data?
    @State private var message: String?
    @State private var messageIsError = false
    @State private var isImporting = false

    private static var bundleTypes: [UTType] {
        var types: [UTType] = []
        if let umkeys = UTType(filenameExtension: "umkeys") {
            types.append(umkeys)
        }
        types.append(.json)
        types.append(.data)
        return types
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button {
                showImporter = true
            } label: {
                if isImporting {
                    ProgressView()
                } else {
                    Label("Import Keys", systemImage: "key.horizontal.fill")
                }
            }
            .disabled(isImporting)
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(messageIsError ? Theme.Colors.danger : Theme.Colors.secondaryText)
            }
            Text("Keys go straight to this device's Keychain.  Delete the bundle file after importing.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: Self.bundleTypes,
            allowsMultipleSelection: false
        ) { result in
            handlePick(result)
        }
        .sheet(isPresented: Binding(
            get: { pendingBundle != nil },
            set: { if !$0 { pendingBundle = nil } }
        )) {
            if let pendingBundle {
                LocalKeysPassphraseSheet(model: model, bundle: pendingBundle) { line, failed in
                    message = line
                    messageIsError = failed
                }
            }
        }
    }

    private func handlePick(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            pendingBundle = try Data(contentsOf: url)
            message = nil
            messageIsError = false
        } catch {
            message = error.localizedDescription
            messageIsError = true
        }
    }
}

private struct LocalKeysPassphraseSheet: View {
    @Bindable var model: LocalAppModel
    let bundle: Data
    let onFinish: (String, Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var passphrase = ""
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Bundle passphrase", text: $passphrase)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Enter the passphrase used when the bundle was created.  Keys are written to this device's Keychain only.")
                }
                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.danger)
                }
            }
            .navigationTitle("Import Keys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") { Task { await run() } }
                        .disabled(isWorking || passphrase.isEmpty)
                }
            }
            .interactiveDismissDisabled(isWorking)
        }
    }

    private func run() async {
        isWorking = true
        error = nil
        defer { isWorking = false }
        do {
            let r = try await LocalKeysImportBuilder.importBundle(
                data: bundle,
                passphrase: passphrase,
                model: model
            )
            var line = "Imported \(r.imported) key\(r.imported == 1 ? "" : "s")"
            if r.replaced > 0 { line += ", replaced \(r.replaced)" }
            if r.skippedUnknown > 0 { line += ", skipped \(r.skippedUnknown) unknown" }
            line += "."
            if let c = r.configResult {
                line += "  Config: \(c.providers) providers, \(c.subscriptions) fees, \(c.snapshots) snapshots."
            }
            line += "  Delete the bundle file now — this app cannot delete the original."
            onFinish(line, false)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

#if canImport(UIKit)
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
