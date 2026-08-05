#!/usr/bin/env bash
# Ship **Local Usage Monitor** (on-device / free App Store candidate) to TestFlight.
# Bundle ID: services.jays.local.usage.monitor
# Does NOT ship the remote client (services.jays.usage.monitor).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh usage-local --repo-root "$ROOT" "$@"
