# Usage Monitor iOS

Native app lives under `ios/UsageMonitor/` (XcodeGen: `project.yml`).

## Generate and build

```bash
cd ios/UsageMonitor && xcodegen generate
xcodebuild -project UsageMonitor.xcodeproj -scheme UsageMonitor \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

## TestFlight ship (no Xcode UI)

```bash
# From repo root
bash scripts/ios-ship-testflight.sh
bash scripts/ios-ship-testflight.sh --export-only
```

Fleet driver: `/Users/jay/apps/ios-fleet/README.md`.

- Bundle ID: `services.jays.usage.monitor` (widget: `services.jays.usage.monitor.widget`)
- Team: `CC8UTF7ATG`
- Secrets: `~/.secrets/appstore-connect.env` (optional if Xcode session can upload)
