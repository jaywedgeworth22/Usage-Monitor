#!/usr/bin/env bash
# Thin wrapper: ship Usage Local Monitor to TestFlight (no Xcode UI).
# Prefer the in-repo fleet script so GitHub-hosted macos-26 can ship
# App Store binaries.  The host copy is a fallback only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

IN_REPO="${ROOT}/scripts/ios-fleet/ship-testflight.sh"
HOST_COPY="/Users/jay/apps/ios-fleet/ship-testflight.sh"
if [[ -f "$IN_REPO" ]]; then
  SHIP_SCRIPT="$IN_REPO"
elif [[ -f "$HOST_COPY" ]]; then
  echo "[ios-ship] WARNING: in-repo fleet script missing; using host copy" >&2
  SHIP_SCRIPT="$HOST_COPY"
else
  echo "error: no ship-testflight.sh (looked at ${IN_REPO})" >&2
  exit 1
fi
exec bash "$SHIP_SCRIPT" usage-local --repo-root "$ROOT" "$@"
