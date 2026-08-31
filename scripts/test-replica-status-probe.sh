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

# Cost efficiency (2026-08-31): the in-container `docker exec ... --once`
# heartbeat attempt always fails on this infra (docker exec never carries
# the Infisical-injected env) and is short-circuited — the probe must go
# straight to the host env-file LTX fallback, and must query only levels 0
# and 9 (not the redundant 1/2/3 mid-tier compaction levels), to hold the
# call count at 2/tick instead of 5/tick.
if grep -nE 'run_in_container_heartbeat' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still attempts the always-failing in-container heartbeat"
fi
if grep -vE '^\s*#' "$COOLIFY_PROBE" | grep -nE 'docker exec.*replica-status-heartbeat\.sh' >/dev/null; then
  fail "coolify probe still execs replica-status-heartbeat.sh in-container"
fi
grep -q 'for level in (0, 9)' "$COOLIFY_PROBE" \
  || fail "coolify probe must query exactly levels 0 and 9"
if grep -nE 'for level in \(0, 1, 2, 3, 9\)' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still scans all five levels per tick"
fi

# Timer cadence: widened 10min -> 30min alongside the level trim (2026-08-31).
TIMER="$ROOT/deploy/coolify/usage-monitor-replica-status.timer"
grep -q 'OnUnitActiveSec=30min' "$TIMER" || fail "timer missing 30min cadence"
if grep -nE 'OnUnitInactiveSec=10min' "$TIMER" >/dev/null; then
  fail "timer still on the old 10min cadence"
fi

# Fixture-driven classify / snapshot behavior.
bash "$HEARTBEAT" --self-test || fail "heartbeat --self-test"

printf 'ok  replica-status-probe offline checks\n'
