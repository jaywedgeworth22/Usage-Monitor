# 2026-08-11 — Usage Local / Client Invalid Binary (ASC)

## Symptom
App Store Connect History: `Waiting for Review` → `Invalid Binary` within
minutes. TestFlight builds remain `VALID`. After rejection, the version returns
to `PREPARE_FOR_SUBMISSION` with a review submission in `UNRESOLVED_ISSUES`
(item `REJECTED`).

## Live ASC snapshot (Grok query, 2026-08-11)

| | Usage Client Monitor | Usage Local Monitor |
|--|--|--|
| ASC app id | `6799230435` | `6799230729` |
| Bundle | `services.jays.usage.client.monitor` | `services.jays.usage.local.monitor` |
| Version id (1.0.0) | `4dd15570-c956-4895-93f3-d3e7adc21080` | `7ddabffc-9fbd-413d-addd-34476fa5cefd` |
| Version state | **PREPARE_FOR_SUBMISSION** | **PREPARE_FOR_SUBMISSION** |
| Selected build | `202608110228` (`61a56c91-…`) **VALID** | `202608110240` (`37781ae5-…`) **VALID** |
| minOsVersion on build | `26.0` | `26.0` |
| usesNonExemptEncryption | false | false |
| buildAudienceType | APP_STORE_ELIGIBLE | APP_STORE_ELIGIBLE |
| Content rights | `DOES_NOT_USE_THIRD_PARTY_CONTENT` | same |
| Age rating | FOUR_PLUS | FOUR_PLUS |
| Category | DEVELOPER_TOOLS + PRODUCTIVITY | same |
| Privacy / support URLs | set on app info + version loc | same |
| Screenshots | iPhone 67 + iPad 129, 5 each, COMPLETE | same |
| Review contact + notes | set | set |
| whatsNew | not editable on first version (API 409) | same |
| Review submission | `f2165cc8-…` **UNRESOLVED_ISSUES** (item REJECTED) | `d1916f43-…` **UNRESOLVED_ISSUES** (item REJECTED); several empty `READY_FOR_REVIEW` shells also present |
| App Store profiles | ACTIVE regen2/regen with App Groups | ACTIVE regen with App Groups |
| Xcode Cloud (`ciProduct`) | none | none |

### Listing gaps vs `docs/asc/APP-STORE-LISTING.md`
- Metadata pack is essentially complete (description, keywords, promo, URLs,
  age, category, screenshots, review notes, content rights, export compliance
  flag on build).
- **whatsNew** cannot be set until a non-1.0 version (ASC 409).
- **App Privacy nutrition labels** are not queryable via the API paths tried
  (`appDataUsages` 404). Confirm in ASC UI that answers match the listing pack
  (no tracking; Client = user-server financial/functionality; Local = data not
  collected by developer / third-party APIs user configures).
- Accessibility declarations exist as **DRAFT** (not required for every market
  today; publish later if ASC prompts).

## Fixed earlier (profiles / PrivacyInfo)
1. **App Store profiles were INVALID** with empty `application-groups []`.
   Regenerated via ASC API — Local/Client/Widget App Store profiles ACTIVE.
2. **PrivacyInfo.xcprivacy** wired on Local/Client/widget targets.
3. Content rights: `DOES_NOT_USE_THIRD_PARTY_CONTENT`.
4. Local IPA `202608110222` codesign shows
   `group.services.jays.usage.local.monitor` + PrivacyInfo present.
5. Older Client IPA `202608082315` on disk still shows empty app-groups and no
   PrivacyInfo — **do not reattach that build**. Selected Client build is
   newer (`202608110228`).

## Root cause still open: beta build host

Host that produced the current IPAs:

| Field | Value |
|------|--------|
| `ProductVersion` | macOS **27.0** |
| `BuildVersion` / `BuildMachineOSBuild` | **26A5353q** |
| Xcode.app | 26.6 (`17F113`) |
| Also present | `Xcode-beta.app` 27.0 |
| `MinimumOSVersion` in IPA | **26.0** |
| `DTSDKBuild` | `23F81a` (SDK stamp) |

Apple commonly rejects **App Store review** binaries built on **beta macOS**
even when TestFlight accepts them. Same host stamp is on Socratic artifacts
(`BuildMachineOSBuild = 26A5353q`) — fleet-wide, not UM-only.

**Re-submitting current VALID builds will almost certainly flip to
INVALID_BINARY again within minutes.** Do not burn another review cycle until
a non-beta host binary is uploaded.

## Min OS recommendation

**Safe to lower to iOS 17.0** (match Congress.Trade). Code scan shows no hard
iOS 26-only APIs:

- `@Observable` / Observation → iOS 17+
- `NavigationStack`, `ContentUnavailableView`, `sensoryFeedback`,
  `containerBackground(for: .widget)` → iOS 17+
- Widget `AppIntentConfiguration` / `WidgetConfigurationIntent` → iOS 17+
- `TimeframePicker` only *comments* on iOS 26 Menu polish; no API gate

**iOS 18.0** is also fine if the owner prefers a narrower floor; **17.0** is the
better App Store reach choice and matches CT.

Lowering min OS alone **does not** fix INVALID_BINARY (beta host does). Do both:
drop target **and** rebuild on stable macOS/GM Xcode (or Xcode Cloud non-beta).

### Exact code change (apply on clean branch / worktree — not mixed with web fixes)

Files:

1. `ios/UsageMonitor/project.yml`
   - `options.deploymentTarget.iOS: "17.0"`
   - `settings.base.IPHONEOS_DEPLOYMENT_TARGET: "17.0"`
   - Keep `xcodeVersion: "26.0"` if still generating on Xcode 26; optional.
2. `ios/UsageMonitor/UsageMonitorKit/Package.swift`
   - `platforms: [.iOS("17.0")]`
3. Regenerate project:
   ```bash
   cd ios/UsageMonitor && xcodegen generate
   ```
   (pbxproj `IPHONEOS_DEPLOYMENT_TARGET` becomes 17.0 via generate)

Branch **`grok/um-ios-min-os-17`** (worktree) implements the 17.0 floor.
Parent web branch `grok/um-prod-revision-and-asc-publish` stays separate.

## Submit readiness

| Gate | Status |
|------|--------|
| Listing / screenshots / category / age / URLs | Ready |
| Build selected + VALID + APP_STORE_ELIGIBLE | Ready (current) |
| Export compliance (`usesNonExemptEncryption=false`) | Ready |
| Profiles + App Groups + PrivacyInfo (on latest Local IPA) | Ready |
| Binary built on non-beta macOS | **BLOCKED** |
| Min OS audience (optional improve) | Recommend 17.0 before re-ship |

### Attach latest VALID build (already done for both)

If needed again after a new upload:

```bash
# uses ~/.secrets/appstore-connect.env — never print secrets
# PATCH /v1/appStoreVersions/{version_id} relationship build
```

Python sketch (same JWT pattern as other ASC scripts):

```python
# Client version 4dd15570-…  Local 7ddabffc-…
# PATCH body:
{
  "data": {
    "type": "appStoreVersions",
    "id": "<version_id>",
    "relationships": {
      "build": {
        "data": {"type": "builds", "id": "<build_id>"}
      }
    }
  }
}
```

### Submit for Review (only after non-beta binary)

```python
# 1) POST /v1/reviewSubmissions
#    { data: { type: reviewSubmissions, attributes: { platform: IOS },
#              relationships: { app: { data: { type: apps, id: <app_id> }}}}}
# 2) POST /v1/reviewSubmissionItems
#    { data: { type: reviewSubmissionItems,
#              relationships: {
#                reviewSubmission: { data: { type: reviewSubmissions, id: <rs_id> }},
#                appStoreVersion: { data: { type: appStoreVersions, id: <version_id> }}
#              }}}
# 3) PATCH /v1/reviewSubmissions/{rs_id}
#    { data: { type: reviewSubmissions, id: <rs_id>,
#              attributes: { submitted: true } } }   # confirm attribute name against live OpenAPI if 422
```

Or use ASC UI: version 1.0.0 → select build → Add for Review → Submit.

Prefer UI if multiple stale `READY_FOR_REVIEW` shells exist on Local (clean up
orphaned review submissions first if ASC complains).

## Owner / agent action list

### Blocked only by beta macOS (cannot fix in this repo alone)
1. Rebuild + upload from **stable macOS + GM Xcode**, **or** set up **Xcode Cloud**
   with a non-beta macOS image (no `ciProduct` today).
2. Prefer build number `> 202608110240` (Local) / `> 202608110228` (Client).
3. Confirm new IPA: `BuildMachineOSBuild` is **not** `26A5353q` (no beta `A` train).
4. Attach new builds → Submit for Review.

### Fixable in code / ASC now
1. **Lower deployment target to 17.0** (project.yml + Package.swift + xcodegen) on
   a dedicated branch; land before re-ship so the next binary is not min iOS 26.
2. Confirm App Privacy nutrition in ASC UI matches listing pack (API opaque).
3. Optional: publish accessibility declarations if ASC shows a soft warning.
4. Do **not** re-submit current beta-host builds.
5. Listing/screenshot push already complete; `whatsNew` blocked until 1.0.x+.

### Exact re-ship commands (after stable host available)

```bash
# From clean tree with min-OS 17.0 landed:
bash scripts/ios-ship-testflight.sh --force-ship          # Client
bash /Users/jay/apps/ios-fleet/ship-testflight.sh usage-local \
  --repo-root /Users/jay/Code/Usage-Monitor --force-ship  # Local

# Optional metadata refresh (whatsNew may still 409 on 1.0.0):
ruby scripts/asc-push-listing.rb --all
```

Then attach builds (if ship script does not) and Submit for Review.

## References
- Listing pack: `docs/asc/APP-STORE-LISTING.md`
- Ship: `scripts/ios-ship-testflight.sh` → `/Users/jay/apps/ios-fleet/ship-testflight.sh`
- ASC env: `~/.secrets/appstore-connect.env` (never print)
- Team: `CC8UTF7ATG`
