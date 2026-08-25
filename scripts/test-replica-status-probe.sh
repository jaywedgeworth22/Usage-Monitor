#!/usr/bin/env bash
# Offline checks for replica health probing scripts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEARTBEAT="$ROOT/scripts/replica-status-heartbeat.sh"
COOLIFY_PROBE="$ROOT/deploy/coolify/replica-status-probe.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

bash -n "$HEARTBEAT" || fail "heartbeat bash -n"
bash -n "$COOLIFY_PROBE" || fail "coolify probe bash -n"

grep -q '\-json' "$HEARTBEAT" || fail "heartbeat missing ltx -json"
grep -q 'SNAPSHOT_LEVEL=9' "$HEARTBEAT" || fail "heartbeat missing snapshot level 9"
grep -q 'list_timeout' "$HEARTBEAT" || fail "heartbeat missing list_timeout reason"
grep -q 'snapshot_only' "$HEARTBEAT" || fail "heartbeat missing snapshot_only reason"
grep -q 'empty_ltx' "$HEARTBEAT" || fail "heartbeat missing empty_ltx reason"

if grep -nE 'NF == 5' "$HEARTBEAT" >/dev/null; then
  fail "heartbeat still uses awk NF==5 parsing"
fi

if grep -nE 'for level in 0 1 2 3 4 5' "$HEARTBEAT" >/dev/null; then
  fail "heartbeat still scans levels 0-5"
fi

if grep -nE '\-level all' "$HEARTBEAT" "$COOLIFY_PROBE" >/dev/null; then
  fail "probe still uses -level all"
fi

# Host probe must never put replica secrets on docker exec argv.
if grep -nE 'extend\(\["-e"|"-e", f"\{k\}=' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still passes -e KEY=VALUE on docker exec argv"
fi
if grep -nE 'docker exec.*LITESTREAM_S3_' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe interpolates LITESTREAM_S3_* into docker exec argv"
fi
grep -q '\-\-env-file' "$COOLIFY_PROBE" || fail "coolify probe missing docker exec --env-file"

# In-container verdict must win over host credential-missing fallback.
grep -q 'status_mtime_before' "$COOLIFY_PROBE" || fail "coolify probe missing mtime guard"
grep -q 'in-container heartbeat verdict' "$COOLIFY_PROBE" \
  || fail "coolify probe missing in-container verdict preference"

# Fixture-driven classify / snapshot behavior.
bash "$HEARTBEAT" --self-test || fail "heartbeat --self-test"

printf 'ok  replica-status-probe offline checks\n'
