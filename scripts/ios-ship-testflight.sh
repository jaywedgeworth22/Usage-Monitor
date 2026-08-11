#!/usr/bin/env bash

# Force stable Xcode.app (not Xcode-beta) for ASC/TestFlight.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
# Thin wrapper: ship this app's native iOS binary to TestFlight (no Xcode UI).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh usage --repo-root "$ROOT" "$@"
