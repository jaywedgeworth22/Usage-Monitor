#!/usr/bin/env bash
# Offline checks for the pinned AppUpdatePrompt.swift copy + Apple ID registry.
# No network.  No xcodebuild.  No TestFlight upload.  No testers.json writes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PIN="${REPO_ROOT}/scripts/ios-fleet/AppUpdatePrompt.swift"
APPS="${REPO_ROOT}/scripts/ios-fleet/apps.json"
SHIP_YML="${REPO_ROOT}/.github/workflows/ios-ship.yml"

PASS=0
FAIL=0
check() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok  : $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

echo "== pin script =="
bash -n "${SCRIPT_DIR}/ios-fleet-pin.sh" && echo "  ok  : ios-fleet-pin.sh parses"
bash "${SCRIPT_DIR}/ios-fleet-pin.sh" --check
check "pin --check exits 0" "0" "0"

echo "== copies =="
if cmp -s "$PIN" "${REPO_ROOT}/ios/UsageMonitor/App/AppUpdatePrompt.swift"; then
  check "App target matches pin" "0" "0"
else
  check "App target matches pin" "0" "1"
fi
if cmp -s "$PIN" "${REPO_ROOT}/ios/UsageMonitor/LocalApp/AppUpdatePrompt.swift"; then
  check "LocalApp target matches pin" "0" "0"
else
  check "LocalApp target matches pin" "0" "1"
fi

echo "== no hardcoded Apple IDs =="
if grep -q 'knownAppleIds' "$PIN"; then
  check "knownAppleIds removed from pin" "absent" "present"
else
  check "knownAppleIds removed from pin" "absent" "absent"
fi
if grep -q 'online.dealdex' "$PIN"; then
  check "stale online.dealdex off Swift" "absent" "present"
else
  check "stale online.dealdex off Swift" "absent" "absent"
fi

echo "== apps.json Apple IDs =="
eval "$(python3 - "$APPS" <<'PY'
import json, sys
apps = json.load(open(sys.argv[1]))["apps"]
print(f"usage_appleId={apps.get('usage', {}).get('appleId', '')}")
print(f"usage_local_appleId={apps.get('usage-local', {}).get('appleId', '')}")
print(f"socratic_appleId={apps.get('socratic', {}).get('appleId', '')}")
print(f"congress_appleId={apps.get('congress', {}).get('appleId', '')}")
print(f"dealdex_appleId={apps.get('dealdex', {}).get('appleId', '')}")
print(f"dealdex_bundleId={apps.get('dealdex', {}).get('bundleId', '')}")
PY
)"
check "usage appleId" "6799230435" "${usage_appleId}"
check "usage-local appleId" "6799230729" "${usage_local_appleId}"
check "socratic appleId" "6799238379" "${socratic_appleId}"
check "congress appleId" "6798076688" "${congress_appleId}"
check "live DealDex bundle" "net.dealdex" "${dealdex_bundleId}"
check "live DealDex appleId" "6802474288" "${dealdex_appleId}"

echo "== testers.json untouched =="
if [[ -e "${REPO_ROOT}/scripts/ios-fleet/testers.json" ]] || [[ -e "${REPO_ROOT}/testers.json" ]]; then
  check "testers.json not added" "absent" "present"
else
  check "testers.json not added" "absent" "absent"
fi

echo "== ios-ship stays Client-only =="
if grep -E '^[[:space:]]+.*[[:space:]]--force-ship([[:space:]]|$)' "$SHIP_YML"; then
  check "ios-ship.yml has no --force-ship flag" "absent" "present"
else
  check "ios-ship.yml has no --force-ship flag" "absent" "absent"
fi
if grep -E 'usage-local|LocalUsageMonitor' "$SHIP_YML" | grep -q 'Ship .*Local'; then
  check "no LocalUsageMonitor ship step" "absent" "present"
else
  check "no LocalUsageMonitor ship step" "absent" "absent"
fi
if grep -q 'LocalUsageMonitor stays skipped' "$SHIP_YML"; then
  check "LocalUsageMonitor skip comment present" "present" "present"
else
  check "LocalUsageMonitor skip comment present" "present" "absent"
fi

echo "== no Swift package =="
if [[ -f "${REPO_ROOT}/ios/UsageMonitor/UsageMonitorKit/Sources/AppCore/AppUpdatePrompt.swift" ]]; then
  check "prompt not in UsageMonitorKit" "absent" "present"
else
  check "prompt not in UsageMonitorKit" "absent" "absent"
fi

echo
echo "${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
