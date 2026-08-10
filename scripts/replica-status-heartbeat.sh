#!/usr/bin/env bash
# Write /data/.litestream-replica-status.json for /api/ready backup verification.
#
# Runs *inside* the app container (or under Infisical-injected env) so
# litestream.yml expands LITESTREAM_S3_* the same way the replicate process
# does. Host-side `docker exec` without that env fails with "bucket required"
# on Coolify, where Infisical injects secrets into the process tree only.
#
# JSON contract matches getBackupRuntimeStatus (src/lib/runtime-health.ts):
#   ok, checkedAt (drives staleness), ltxAgeSeconds + reason (operator only).
# Deliberately omits ageSeconds so a frozen file cannot pass forever.
set -euo pipefail
umask 022
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="${LITESTREAM_DB_PATH:-/data/prod.db}"
STATUS_FILE="${LITESTREAM_REPLICA_STATUS_PATH:-/data/.litestream-replica-status.json}"
# Align with runtime-health default + 1h litestream sync-interval.
MAX_LTX_AGE_SECONDS="${LITESTREAM_REPLICA_MAX_AGE_SECONDS:-10800}"
INTERVAL_SECONDS="${LITESTREAM_REPLICA_HEARTBEAT_INTERVAL_SECONDS:-600}"
ONCE=false

log() {
  printf '[replica-status-heartbeat] %s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    *)
      log "ERROR: unknown arg: $1"
      exit 2
      ;;
  esac
done

# Normalize unified AWS_* names (same as start-with-litestream.sh).
: "${LITESTREAM_S3_BUCKET:=${AWS_S3_BUCKET_NAME:-}}"
: "${LITESTREAM_S3_ENDPOINT:=${AWS_S3_ENDPOINT:-}}"
: "${LITESTREAM_S3_REGION:=${AWS_REGION:-auto}}"
: "${LITESTREAM_S3_ACCESS_KEY_ID:=${AWS_ACCESS_KEY_ID:-}}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY:=${AWS_SECRET_ACCESS_KEY:-}}"
export LITESTREAM_S3_BUCKET LITESTREAM_S3_ENDPOINT LITESTREAM_S3_REGION \
  LITESTREAM_S3_ACCESS_KEY_ID LITESTREAM_S3_SECRET_ACCESS_KEY

write_status() {
  local ok="$1" ltx_age="$2" reason="$3"
  local checked_at temporary dir
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dir="$(dirname "${STATUS_FILE}")"
  mkdir -p "${dir}"
  temporary="$(mktemp "${STATUS_FILE}.XXXXXX")"
  if command -v jq >/dev/null 2>&1; then
    jq -nc \
      --argjson ok "${ok}" \
      --argjson ltxAgeSeconds "${ltx_age}" \
      --arg reason "${reason}" \
      --arg checkedAt "${checked_at}" \
      '{ok: $ok, checkedAt: $checkedAt, ltxAgeSeconds: $ltxAgeSeconds,
        reason: (if $reason == "" then null else $reason end)}' \
      >"${temporary}"
  else
    # Minimal JSON without jq (Alpine/node image may lack it).
    local reason_json=null
    if [[ -n "${reason}" ]]; then
      reason_json="\"${reason//\"/\\\"}\""
    fi
    printf '{"ok":%s,"checkedAt":"%s","ltxAgeSeconds":%s,"reason":%s}\n' \
      "${ok}" "${checked_at}" "${ltx_age}" "${reason_json}" >"${temporary}"
  fi
  chmod 0644 "${temporary}"
  mv -f "${temporary}" "${STATUS_FILE}"
}

list_ltx_level() {
  local level="$1"
  timeout 60 "${LITESTREAM_BIN}" ltx \
    -config "${LITESTREAM_CONFIG}" \
    -level "${level}" \
    "${DB_PATH}"
}

newest_ltx_created() {
  local listing level latest
  for level in 0 1 2 3 4 5; do
    if listing="$(list_ltx_level "${level}" 2>/dev/null)"; then
      latest="$(awk 'NF == 5 && $1 ~ /^[0-9]+$/ { print $5 }' \
        <<<"${listing}" | sort | tail -n 1)"
      if [[ -n "${latest}" ]]; then
        printf '%s\n' "${latest}"
        return 0
      fi
    fi
  done
  return 1
}

probe_once() {
  # R2-only kill: when endpoint is R2 and kill is engaged, report intentional pause.
  local endpoint_lc
  endpoint_lc="$(printf '%s' "${LITESTREAM_S3_ENDPOINT:-}" | tr '[:upper:]' '[:lower:]')"
  local is_r2=false
  if [[ "${endpoint_lc}" == *"r2.cloudflarestorage.com"* || "${endpoint_lc}" == *".r2.cloudflare.com"* ]]; then
    is_r2=true
  fi
  if [[ "${is_r2}" == "true" ]] && {
    [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" ]] \
      || [[ "${R2_WRITES_DISABLED:-false}" == "true" ]] \
      || [[ -f /data/r2-disabled-70pct.flag ]]
  }; then
    write_status false null "r2_free_tier_disabled"
    log "R2 free-tier kill engaged; reporting intentional replica pause."
    return 0
  fi

  if [[ ! -x "${LITESTREAM_BIN}" ]]; then
    write_status false null "litestream_binary_missing"
    log "ERROR: litestream binary missing at ${LITESTREAM_BIN}"
    return 1
  fi

  if [[ -z "${LITESTREAM_S3_BUCKET:-}" || -z "${LITESTREAM_S3_ENDPOINT:-}" \
    || -z "${LITESTREAM_S3_ACCESS_KEY_ID:-}" || -z "${LITESTREAM_S3_SECRET_ACCESS_KEY:-}" ]]; then
    write_status false null "replica_credentials_missing"
    log "ERROR: LITESTREAM_S3_* incomplete; cannot list LTX."
    return 1
  fi

  local latest_created latest_epoch now_epoch age_seconds
  if ! latest_created="$(newest_ltx_created)"; then
    write_status false null "no_parseable_ltx"
    log "ERROR: no parseable LTX at levels 0-5."
    return 1
  fi

  if ! latest_epoch="$(date -u -d "${latest_created}" +%s 2>/dev/null)"; then
    # BusyBox/macOS fallback not needed in production Linux containers.
    write_status false null "invalid_ltx_timestamp"
    log "ERROR: invalid LTX timestamp: ${latest_created}"
    return 1
  fi

  now_epoch="$(date -u +%s)"
  age_seconds=$((now_epoch - latest_epoch))
  if (( age_seconds < 0 || age_seconds > MAX_LTX_AGE_SECONDS )); then
    write_status false "${age_seconds}" "ltx_age_exceeds_budget"
    log "newest LTX is ${age_seconds}s old (limit ${MAX_LTX_AGE_SECONDS}s)."
    return 0
  fi

  write_status true "${age_seconds}" ""
  log "replica healthy: newest LTX is ${age_seconds}s old (${latest_created})."
  return 0
}

if [[ "${ONCE}" == "true" ]]; then
  probe_once
  exit $?
fi

log "looping every ${INTERVAL_SECONDS}s → ${STATUS_FILE}"
while true; do
  probe_once || true
  sleep "${INTERVAL_SECONDS}"
done
