#!/usr/bin/env bash

# Force stable Xcode.app (not Xcode-beta) for ASC/TestFlight.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
# Ship **Usage Local Monitor** (on-device / free App Store candidate) to TestFlight.
# Bundle ID: services.jays.usage.local.monitor (Usage Local Monitor)
# Does NOT ship Usage Client Monitor (services.jays.usage.client.monitor).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh usage-local --repo-root "$ROOT" "$@"
