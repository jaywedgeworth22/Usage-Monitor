#!/usr/bin/env bash
# Root-owned systemd entrypoint. Polls public GitHub main without any deploy
# credential, then delegates the exact SHA to the fail-closed deploy transaction.
set -euo pipefail
umask 027

readonly REPOSITORY_URL="https://github.com/jaywedgeworth22/Usage-Monitor.git"
readonly HOST_ENV="/etc/usage-monitor/host.env"
readonly PAUSE_FILE="/etc/usage-monitor/auto-deploy.paused"
readonly STATE_DIR="/var/lib/usage-monitor-deploy"
readonly FAILURE_FILE="${STATE_DIR}/failure-state"
readonly BLOCKED_FILE="${STATE_DIR}/blocked-sha"
readonly CHECK_RETRY_FILE="${STATE_DIR}/check-retry-state"
readonly DEPLOY_COMMAND="/usr/local/sbin/usage-monitor-deploy"
readonly PUBLIC_READY_URL="https://usage.jays.services/api/ready?strict=1"
readonly MAX_FAILURES=3
readonly CHECK_RETRY_SECONDS=300

log() {
  printf '[usage-monitor-auto-deploy] %s\n' "$*"
}

read_env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v wanted="${key}" '
    $1 == wanted {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^['\''\"]|['\''\"]$/, "", value)
      print value
      exit
    }
  ' "${file}"
}

write_atomic() {
  local destination="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${STATE_DIR}/.state.XXXXXX")"
  printf '%s\n' "${value}" >"${temporary}"
  chmod 0600 "${temporary}"
  mv -f "${temporary}" "${destination}"
}

clear_failure_state() {
  unlink "${FAILURE_FILE}" 2>/dev/null || true
  unlink "${BLOCKED_FILE}" 2>/dev/null || true
  unlink "${CHECK_RETRY_FILE}" 2>/dev/null || true
}

if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root."
  exit 1
fi

install -d -o root -g root -m 0750 "${STATE_DIR}"

if [[ "${1:-}" == "--retry-blocked" ]]; then
  log "operator cleared the blocked-revision circuit breaker."
  clear_failure_state
  shift
fi
if (( $# != 0 )); then
  log "ERROR: unsupported arguments."
  exit 64
fi

if [[ -e "${PAUSE_FILE}" ]]; then
  log "paused by ${PAUSE_FILE}."
  exit 0
fi

target_sha="$(git ls-remote "${REPOSITORY_URL}" refs/heads/main | cut -f1)"
if [[ ! "${target_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  log "ERROR: GitHub returned no valid main SHA."
  exit 75
fi

if [[ -f "${BLOCKED_FILE}" ]]; then
  blocked_sha="$(tr -d '[:space:]' <"${BLOCKED_FILE}")"
  if [[ "${blocked_sha}" == "${target_sha}" ]]; then
    log "revision ${target_sha} is blocked after a terminal eligibility error or ${MAX_FAILURES} failed deploys."
    exit 0
  fi
  log "main advanced beyond blocked revision ${blocked_sha}; resetting the circuit breaker."
  clear_failure_state
fi

if [[ -f "${CHECK_RETRY_FILE}" ]]; then
  read -r retry_sha retry_after <"${CHECK_RETRY_FILE}" || true
  if [[ "${retry_sha:-}" == "${target_sha}" && "${retry_after:-}" =~ ^[0-9]+$ ]] && \
    (( $(date -u +%s) < retry_after )); then
    log "revision ${target_sha} has a failed required check; waiting for a possible GitHub rerun."
    exit 0
  fi
  unlink "${CHECK_RETRY_FILE}"
fi

current_sha="$(read_env_value "${HOST_ENV}" USAGE_MONITOR_REVISION)"
if [[ "${current_sha}" == "${target_sha}" ]]; then
  if curl -fsS --max-time 15 "${PUBLIC_READY_URL}" \
    | jq -e --arg revision "${target_sha}" \
      '.status == "ready" and .revision == $revision and .checks.database.ok == true and .checks.backup.ok == true and .checks.scheduler.ok == true' \
      >/dev/null; then
    clear_failure_state
    log "production is already healthy at ${target_sha}."
    exit 0
  fi
  log "host state names ${target_sha}, but public readiness does not; requesting an idempotent repair deploy."
fi

set +e
"${DEPLOY_COMMAND}" "${target_sha}"
deploy_status=$?
set -e

case "${deploy_status}" in
  0)
    clear_failure_state
    log "deployment transaction completed for ${target_sha}."
    exit 0
    ;;
  75)
    log "revision ${target_sha} is not deployable yet; required GitHub checks may still be running."
    exit 75
    ;;
  77)
    retry_after=$(( $(date -u +%s) + CHECK_RETRY_SECONDS ))
    write_atomic "${CHECK_RETRY_FILE}" "${target_sha} ${retry_after}"
    unlink "${FAILURE_FILE}" 2>/dev/null || true
    log "revision ${target_sha} has a failed required check; it will be re-evaluated after ${CHECK_RETRY_SECONDS}s."
    exit 0
    ;;
  78)
    write_atomic "${BLOCKED_FILE}" "${target_sha}"
    unlink "${FAILURE_FILE}" 2>/dev/null || true
    log "revision ${target_sha} failed a terminal eligibility guard and is now blocked."
    exit 0
    ;;
esac

failure_count=1
if [[ -f "${FAILURE_FILE}" ]]; then
  read -r failed_sha previous_count <"${FAILURE_FILE}" || true
  if [[ "${failed_sha:-}" == "${target_sha}" && "${previous_count:-}" =~ ^[0-9]+$ ]]; then
    failure_count=$((previous_count + 1))
  fi
fi

if (( failure_count >= MAX_FAILURES )); then
  write_atomic "${BLOCKED_FILE}" "${target_sha}"
  unlink "${FAILURE_FILE}" 2>/dev/null || true
  log "revision ${target_sha} failed ${failure_count} deployment attempts and is now blocked."
  exit 1
fi

write_atomic "${FAILURE_FILE}" "${target_sha} ${failure_count}"
log "revision ${target_sha} deployment failed (attempt ${failure_count}/${MAX_FAILURES}); the timer will retry."
exit 1
