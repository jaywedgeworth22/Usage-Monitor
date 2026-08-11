# 2026-08-11 — Usage Local Monitor Invalid Binary (ASC)

## Symptom
App Store Connect History: `Waiting for Review` → `Invalid Binary` within minutes.
Usage Local **and** Usage Client versions both show `INVALID_BINARY`. TestFlight
builds remain `VALID`.

## Fixed on portal + ship path

1. **App Store profiles were INVALID** with empty `application-groups []`.
   - Deleted and regenerated App Store profiles for Local / Client / Widget via ASC API.
   - New Local IPA codesign includes
     `group.services.jays.usage.local.monitor` (was missing before).
2. **PrivacyInfo.xcprivacy** on Local/Client/widget targets (repo already wired via
   xcodegen `project.yml`).
3. Content rights: `DOES_NOT_USE_THIRD_PARTY_CONTENT` on Local.
4. Re-shipped Local **202608110222** / **202608110223** (TestFlight VALID).

## Still failing for App Store review
Resubmit still flips to `INVALID_BINARY` within ~3 minutes while the build stays VALID.

IPA metadata on this host:

- `BuildMachineOSBuild = 26A5353q` (**macOS 27 beta**)
- `DTXcodeBuild = 17F113` (Xcode 26.6)
- `MinimumOSVersion = 26.0`

Apple commonly rejects **App Store review** binaries built on **beta macOS** even
when TestFlight accepts them. Client shares the same host stamp.

## Owner next step (required for green review)
1. Rebuild + upload from **stable macOS + GM Xcode**, or **Xcode Cloud** with a
   non-beta image.
2. Prefer build number `> 202608110223`.
3. Attach new build to 1.0.0 → Submit for Review.
4. Forward any Apple ITMS email if present (not found in local Mail scan).

## References
- Local ASC app id `6799230729`
- Latest good TF build: `202608110223` (`331d1c1b-…`) with App Groups + PrivacyInfo
