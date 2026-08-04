#!/usr/bin/env bash
# Render startCommand entrypoint. Replaces the raw
# "node scripts/migrate-safe.mjs && npm start" tail with an opt-in wrapper:
#
#   - LITESTREAM_S3_* unset (default): create and integrity-check a bounded
#     local backup of an existing DB, run migrate-safe, then exec npm start.
#     `exec` makes npm start PID 1 so it receives Render's SIGTERM directly
#     instead of a wrapper shell swallowing it.
#   - LITESTREAM_S3_* all set AND bin/litestream present (see
#     scripts/fetch-litestream.sh): restore from R2 if the disk has no DB yet
#     (fresh disk / disaster recovery), run migrate-safe, then exec litestream
#     as PID 1 with npm start as its supervised child (-exec), so every write
#     to /data/prod.db is continuously replicated to R2.
#
# Partial replication configuration, a configured replica with no verified
# binary, or LITESTREAM_REQUIRED=true without an active replica is a startup
# error. This prevents a deploy from silently running without its intended
# backup path.
#
# backup-sqlite-before-migrate.mjs then migrate-safe.mjs run exactly once in
# both paths, before the server starts, and always against the post-restore (or
# existing) database file. An existing database cannot be migrated unless a
# transaction-consistent local backup passes SQLite integrity verification.
#
# Uses `exec` for the final process in each branch so it becomes PID 1 (or
# litestream's supervised child) and receives Render's SIGTERM directly for
# graceful shutdown — no wrapper shell left holding the signal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="/data/prod.db"
export APP_STARTUP_WRAPPER="start-with-litestream-v2"

log() {
  echo "[start-with-litestream] $*"
}

# Normalize AWS_* unified secret names into LITESTREAM_S3_* for litestream.yml expansion
: "${LITESTREAM_S3_BUCKET:=${AWS_S3_BUCKET_NAME:-}}"
: "${LITESTREAM_S3_ENDPOINT:=${AWS_S3_ENDPOINT:-}}"
: "${LITESTREAM_S3_REGION:=${AWS_REGION:-auto}}"
: "${LITESTREAM_S3_ACCESS_KEY_ID:=${AWS_ACCESS_KEY_ID:-}}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY:=${AWS_SECRET_ACCESS_KEY:-}}"
export LITESTREAM_S3_BUCKET LITESTREAM_S3_ENDPOINT LITESTREAM_S3_REGION LITESTREAM_S3_ACCESS_KEY_ID LITESTREAM_S3_SECRET_ACCESS_KEY

REQUIRED_KEYS=(
  LITESTREAM_S3_BUCKET
  LITESTREAM_S3_ENDPOINT
  LITESTREAM_S3_ACCESS_KEY_ID
  LITESTREAM_S3_SECRET_ACCESS_KEY
)

case "${LITESTREAM_REQUIRED:-false}" in
  true|false) ;;
  *)
    log "ERROR: LITESTREAM_REQUIRED must be exactly true or false."
    exit 1
    ;;
esac

configured_keys=0
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -n "${!key:-}" ]]; then
    configured_keys=$((configured_keys + 1))
  fi
done

if (( configured_keys > 0 && configured_keys < ${#REQUIRED_KEYS[@]} )); then
  log "ERROR: Litestream is partially configured (${configured_keys}/${#REQUIRED_KEYS[@]} required values set)."
  log "Set all bucket/endpoint/access-key-id/secret-access-key values together, or unset all four."
  exit 1
fi

# Cloudflare R2 free-tier kill switch applies ONLY when the replica endpoint is
# R2. Garage / MinIO / other S3-compatible endpoints must keep replicating —
# free-tier limits do not apply to them. Detect by endpoint hostname.
litestream_endpoint_is_r2=false
endpoint_lc="$(printf '%s' "${LITESTREAM_S3_ENDPOINT:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "${endpoint_lc}" == *"r2.cloudflarestorage.com"* || "${endpoint_lc}" == *".r2.cloudflare.com"* ]]; then
  litestream_endpoint_is_r2=true
fi

r2_free_tier_kill=false
if [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" || "${R2_WRITES_DISABLED:-false}" == "true" || -f "/data/r2-disabled-70pct.flag" ]]; then
  r2_free_tier_kill=true
fi

litestream_enabled=false
if (( configured_keys == ${#REQUIRED_KEYS[@]} )); then
  if [[ ! -x "${LITESTREAM_BIN}" ]]; then
    log "ERROR: Litestream is configured but the verified binary is unavailable at ${LITESTREAM_BIN}."
    exit 1
  fi
  litestream_enabled=true
  if [[ "${r2_free_tier_kill}" == "true" && "${litestream_endpoint_is_r2}" == "true" ]]; then
    log "WARNING: Litestream replication disabled via R2 free-tier kill switch (70% threshold)."
    log "Endpoint is Cloudflare R2; Garage/non-R2 endpoints would not be disabled."
    litestream_enabled=false
  elif [[ "${r2_free_tier_kill}" == "true" && "${litestream_endpoint_is_r2}" != "true" ]]; then
    log "R2 free-tier kill switch is set, but Litestream endpoint is not R2 — leaving replication ENABLED."
  fi
elif [[ "${LITESTREAM_REQUIRED:-false}" == "true" ]]; then
  log "ERROR: LITESTREAM_REQUIRED=true but no replica credentials are configured."
  exit 1
fi

if [[ "${STARTUP_PREFLIGHT_ONLY:-false}" == "true" ]]; then
  log "preflight OK (replication ${litestream_enabled}; r2_endpoint=${litestream_endpoint_is_r2}; r2_kill=${r2_free_tier_kill})."
  exit 0
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  export LITESTREAM_ACTIVE=true
  log "replication ENABLED (LITESTREAM_S3_* set, bin/litestream present, r2_endpoint=${litestream_endpoint_is_r2})."

  if [[ ! -f "${DB_PATH}" ]]; then
    log "no local DB at ${DB_PATH} — attempting restore from replica (no-op if none exists yet)."
    "${LITESTREAM_BIN}" restore -config "${LITESTREAM_CONFIG}" -if-db-not-exists -if-replica-exists "${DB_PATH}"
  else
    log "local DB already present at ${DB_PATH} — skipping restore."
  fi
else
  export LITESTREAM_ACTIVE=false
  log "replication DISABLED (set LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,"
  log "LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY to enable — see docs/litestream.md)."
fi

log "Disk space on /data before backup:"
df -h /data || true
du -sh /data/.* 2>/dev/null || true
du -sh /data/* 2>/dev/null || true

if [[ -d "/data/.pre-migration-backups" ]]; then
  log "cleaning up old partial pre-migration backups to prevent disk full errors."
  rm -f /data/.pre-migration-backups/*.partial 2>/dev/null || true
fi

log "creating and verifying pre-migration SQLite backup when a database exists."
node "${REPO_ROOT}/scripts/backup-sqlite-before-migrate.mjs"


log "checking provider billing links before enforcing uniqueness."
node "${REPO_ROOT}/scripts/audit-subscription-links.mjs"
node "${REPO_ROOT}/scripts/ensure-subscription-link-unique-index.mjs"

node "${REPO_ROOT}/scripts/migrate-safe.mjs"

if [[ "${litestream_enabled}" == "true" && "${litestream_endpoint_is_r2}" == "true" ]]; then
  # R2 path: run litestream as a sibling of npm so the free-tier kill switch can
  # stop replication mid-cycle without taking the app down. A watcher polls the
  # flag file every 30s and SIGTERMs litestream when it appears (Node maintenance
  # writes it when GraphQL metrics hit 70% free tier).
  log "starting litestream replicate (R2) as supervised sibling of npm start."
  "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" &
  LITESTREAM_PID=$!
  (
    while kill -0 "${LITESTREAM_PID}" 2>/dev/null; do
      if [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" || "${R2_WRITES_DISABLED:-false}" == "true" || -f "/data/r2-disabled-70pct.flag" ]]; then
        log "R2 free-tier kill switch tripped — stopping litestream pid=${LITESTREAM_PID}."
        kill "${LITESTREAM_PID}" 2>/dev/null || true
        wait "${LITESTREAM_PID}" 2>/dev/null || true
        log "litestream stopped; app continues without R2 replication."
        exit 0
      fi
      sleep 30
    done
  ) &
  R2_WATCH_PID=$!
  cleanup_r2_litestream() {
    log "shutting down R2 litestream sibling (pid=${LITESTREAM_PID}) and watcher."
    kill "${R2_WATCH_PID}" 2>/dev/null || true
    kill "${LITESTREAM_PID}" 2>/dev/null || true
    wait "${LITESTREAM_PID}" 2>/dev/null || true
  }
  trap cleanup_r2_litestream SIGTERM SIGINT EXIT
  # npm start as the foreground process (receives container SIGTERM via trap).
  npm start
  app_status=$?
  cleanup_r2_litestream
  trap - SIGTERM SIGINT EXIT
  exit "${app_status}"
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  # Non-R2 (Garage etc.): keep litestream as PID 1 with -exec so the replica
  # process owns signal routing. Free-tier kill never applies here.
  log "starting litestream replicate (non-R2) wrapping npm start as supervised child."
  exec "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" -exec "npm start"
fi

exec npm start
