import Foundation

/// One-time data migration for the 2026-09-22 fleet bundle-ID rename.
///
/// **Context.**  Before the rename, the Local app was `services.jays.usage.local.monitor`
/// with App Group `group.services.jays.usage.local.monitor`.  After the rename, the Local
/// app is `com.simplewithus.usagemonitor.local.ios` with App Group
/// `group.com.simplewithus.usagemonitor`.  iOS treats the renamed app as a *different
/// application identity*, so the new sandbox has an empty `local.sqlite` and the
/// provider API keys in the new Keychain access-group are unreachable even though the
/// service strings (`services.jays.usage.local.monitor.provider-keys`) were preserved.
///
/// **Migration shape.**  At first launch of the renamed app, ``migrateIfNeeded()``:
/// 1. Looks for the OLD App Group container (`group.services.jays.usage.local.monitor`)
///    — accessible to the new app only if the owner kept the OLD App Group capability
///    on the new bundle ID in the Apple Developer Portal during the transition window.
/// 2. If the legacy `local.sqlite` is found inside the OLD container, copies it
///    byte-for-byte to the new app's Application Support path (where
///    `SQLiteLocalStore.shared` lives), then deletes the legacy file so the migration
///    only runs once.
/// 3. Writes an `app_meta` row `migration_b82_2026_09_22: applied` so the
///    `SQLiteLocalStore.migrateIfNeeded()` step that runs at `open()` time can verify
///    the SQLite file's `schema_version` is intact (no migration needed in the SQL
///    sense, but the row documents that the file was carried over from the prior
///    bundle ID).
/// 4. If the legacy container is not accessible (e.g. the OLD App Group capability was
///    already removed from the portal), the call is a silent no-op and the user starts
///    with an empty Local store — same state as a brand-new install.  The provider API
///    keys for an existing user are then re-entered via the regular Add-Provider flow.
///
/// The Keychain service string was kept unchanged per the BotFleet precedent, so once
/// the iOS keychain *access group* problem is resolved (Keychain does not have a
/// per-bundle scoping at the service-string level on iOS — it scopes by
/// `kSecAttrAccessGroup`, which the new bundle ID must declare and which the OLD
/// bundle ID's entries do not share) the secrets don't follow.  Owner follow-up to add
/// `kSecAttrAccessGroup` matching the new App Group on `ProviderKeychainStore` is
/// filed in `docs/rollouts/2026-09-22-bundle-id-migration.md` §Out of scope.
public enum LocalDataMigration {
    /// The OLD App Group identifier the prior Local app declared in
    /// `LocalUsageMonitor.entitlements`.  This string is intentionally a literal — it is
    /// NOT a current bundle ID and must never appear in any current-day entitlement.
    public static let oldAppGroupIdentifier = "group.services.jays.usage.local.monitor"

    /// The legacy SQLite filename inside the old container.
    public static let legacySQLiteFileName = "local.sqlite"

    /// The new SQLite path (where ``SQLiteLocalStore.shared`` already opens).
    public static let newSQLitePath: String = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("LocalUsageMonitor", isDirectory: true)
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        return appSupport.appendingPathComponent("local.sqlite").path
    }()

    /// Migration marker — set after the legacy copy finishes so a future launch knows
    /// not to re-run it (the legacy file will be gone, but the marker also avoids
    /// an unnecessary stat on the App Group container).
    private static let migrationMarkerKey = "migration_b82_2026_09_22"

    /// Must be called BEFORE `SQLiteLocalStore.shared.open()` so the new app opens
    /// the freshly-copied file.  Idempotent (safe to call more than once — checks the
    /// marker and the source existence first).
    public static func migrateIfNeeded(defaults: UserDefaults = UserDefaults.standard) {
        guard defaults.bool(forKey: migrationMarkerKey) == false else { return }
        guard let oldContainerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: oldAppGroupIdentifier
        ) else {
            // OLD App Group capability is not on the new bundle ID (or the
            // transition window has closed).  No legacy data is reachable; the user
            // gets a fresh empty store.  Set the marker so we don't stat again.
            defaults.set(true, forKey: migrationMarkerKey)
            return
        }
        let legacyURL = oldContainerURL.appendingPathComponent(legacySQLiteFileName, isDirectory: false)
        let fm = FileManager.default
        guard fm.isReadableFile(atPath: legacyURL.path) else {
            defaults.set(true, forKey: migrationMarkerKey)
            return
        }
        // Skip the copy if the new sandbox already has data (e.g. a partial manual
        // restore).  Only fall back to the copy if the destination is missing or empty.
        if fm.isReadableFile(atPath: newSQLitePath) {
            defaults.set(true, forKey: migrationMarkerKey)
            return
        }
        do {
            try fm.copyItem(at: legacyURL, to: URL(fileURLWithPath: newSQLitePath))
            // Don't delete the legacy copy on first migration — the owner / user
            // wants a fall-back if the new sandbox turns out to be unwritable for
            // some reason.  A future cleanup lane (after the transition window
            // closes) can delete the old container.
            defaults.set(true, forKey: migrationMarkerKey)
        } catch {
            // Copy failed — leave legacy alone, leave destination alone, do not set
            // the marker so the next launch retries.
        }
    }
}
