# 2026-08-11 — Usage Local Monitor Invalid Binary (ASC)

## Symptom
App Store Connect History: `Waiting for Review` → `Invalid Binary` within minutes.
Both Usage Local and Usage Client versions showed `INVALID_BINARY`. TestFlight
builds remain `VALID`.

## Fixed (code + portal)

1. **App Store profiles were INVALID** with empty `application-groups []`.
   - Deleted bad profiles; regenerated App Store profiles for Local / Client / Widget.
   - New Local IPA ships with
     `com.apple.security.application-groups = [group.services.jays.usage.local.monitor]`.
2. **PrivacyInfo.xcprivacy** added to Local, Client, and Client widget targets
   (file timestamp `C617.1`, disk space `E174.1`).
3. Content rights set to `DOES_NOT_USE_THIRD_PARTY_CONTENT` on Local app record.
4. Re-shipped Local build **202608110222** / **202608110223** (VALID on TestFlight).

## Still failing after re-submit
Resubmit still flipped to `INVALID_BINARY` within ~3 minutes. Build stays VALID.

Likely remaining host constraint (not fixed by profile regen alone):

- IPA `BuildMachineOSBuild = 26A5353q` (macOS **27 beta**). Apple commonly rejects
  App Store review binaries built on beta OS even when TestFlight accepts them.
- Same stamp on Client / Socratic fleet IPAs built on this Mac.

## Owner next steps
1. Open App Store Connect email for ITMS-xxxxx (authoritative reason).
2. Rebuild from **stable macOS + GM Xcode** (or Xcode Cloud stable image), not
   macOS 27 beta, then re-upload + Submit for Review.
3. Keep regenerated App Store profiles (App Groups populated).

## Build references
- Local bundle: `services.jays.usage.local.monitor` (ASC app 6799230729)
- Good TF build: `202608110223` (id `331d1c1b-…`) with App Groups + PrivacyInfo
