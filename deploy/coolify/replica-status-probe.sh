#!/usr/bin/env bash
# Coolify/Hetzner host probe: prove Litestream replica freshness for Usage Monitor.
#
# Install on fleet-hetzner-nbg1 as /usr/local/sbin/usage-monitor-replica-status
# and drive with a 10-minute systemd timer. Writes into the Coolify volume that
# is mounted at /data inside the app container so Next.js can read the verdict
# at LITESTREAM_REPLICA_STATUS_PATH (default /data/.litestream-replica-status.json).
#
# Why not reuse deploy/oracle/replica-status-probe.sh?
#   - Coolify container names are UUID-based, not usage-monitor-app-1
#   - Coolify injects secrets via Infisical into the process tree; bare
#     `docker exec litestream ltx` fails with "bucket required"
#   - Container /proc/*/environ is ptrace-restricted; host root reads the
#     litestream PID via `docker top` instead
#
# Secret safety: never pass LITESTREAM_S3_* (or any replica credential) on
# docker exec argv — systemd journals capture argv. Host fallback injects env
# via a mode-0600 --env-file that is deleted immediately after exec.
set -euo pipefail
umask 022
export LC_ALL=C

# Coolify application uuid for Usage Monitor (see fleet-ops for UUID).
readonly APP_UUID_PREFIX="${USAGE_MONITOR_COOLIFY_UUID:-${APP_UUID:-usage-monitor}}"
readonly VOLUME_NAME="${USAGE_MONITOR_DATA_VOLUME:-${APP_UUID_PREFIX}-usage-data}"
readonly STATUS_BASENAME=".litestream-replica-status.json"
readonly MAX_LTX_AGE_SECONDS="${LITESTREAM_REPLICA_MAX_AGE_SECONDS:-10800}"

log() {
  printf '[usage-monitor-replica-status] %s\n' "$*"
}

if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root."
  exit 1
fi

find_container() {
  docker ps --format '{{.Names}}' | awk -v p="${APP_UUID_PREFIX}" '
    index($0, p) == 1 { print; exit }
  '
}

volume_status_path() {
  local src
  src="$(docker volume inspect -f '{{.Mountpoint}}' "${VOLUME_NAME}" 2>/dev/null || true)"
  if [[ -z "${src}" ]]; then
    return 1
  fi
  printf '%s/%s\n' "${src}" "${STATUS_BASENAME}"
}

write_status_host() {
  local status_file="$1" ok="$2" ltx_age="$3" reason="$4"
  local checked_at temporary
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temporary="$(mktemp "${status_file}.XXXXXX")"
  jq -nc \
    --argjson ok "${ok}" \
    --argjson ltxAgeSeconds "${ltx_age}" \
    --arg reason "${reason}" \
    --arg checkedAt "${checked_at}" \
    '{ok: $ok, checkedAt: $checkedAt, ltxAgeSeconds: $ltxAgeSeconds,
      reason: (if $reason == "" then null else $reason end)}' \
    >"${temporary}"
  chmod 0644 "${temporary}"
  # Container runs as uid 1000 (node); keep world-readable non-secret verdict.
  chown 1000:1000 "${temporary}" 2>/dev/null || true
  mv -f "${temporary}" "${status_file}"
}

status_mtime_epoch() {
  local path="$1"
  stat -c '%Y' "${path}" 2>/dev/null || stat -f '%m' "${path}" 2>/dev/null || echo 0
}

CONTAINER="$(find_container || true)"
STATUS_FILE="$(volume_status_path || true)"

if [[ -z "${CONTAINER}" ]]; then
  log "ERROR: no running container with prefix ${APP_UUID_PREFIX}"
  exit 1
fi
if [[ -z "${STATUS_FILE}" ]]; then
  log "ERROR: docker volume ${VOLUME_NAME} not found"
  exit 1
fi

status_checked_at_before="$(jq -r '.checkedAt // empty' "${STATUS_FILE}" 2>/dev/null || true)"
status_mtime_before="$(status_mtime_epoch "${STATUS_FILE}")"

run_in_container_heartbeat() {
  docker exec "${CONTAINER}" bash /app/scripts/replica-status-heartbeat.sh --once 2>/dev/null
}

# Prefer a cred-equipped in-container heartbeat (the looping child of
# start-with-litestream, which inherits Infisical).  `docker exec --once`
# does not — Coolify injects secrets into the process tree only, so that
# path writes replica_credentials_missing and must not skip the host
# --env-file fallback.  Trust the --once write only when it exits 0
# (healthy, snapshot_only, age-exceeded, or an intentional R2 pause).
hb_rc=0
run_in_container_heartbeat || hb_rc=$?
status_mtime_after="$(status_mtime_epoch "${STATUS_FILE}")"
status_checked_at_after="$(jq -r '.checkedAt // empty' "${STATUS_FILE}" 2>/dev/null || true)"

if [[ "${hb_rc}" -eq 0 && -f "${STATUS_FILE}" ]] \
  && { (( status_mtime_after > status_mtime_before )) || [[ -n "${status_checked_at_after}" && "${status_checked_at_after}" != "${status_checked_at_before}" ]]; }; then
  if jq -e '.checkedAt != null and .checkedAt != ""' "${STATUS_FILE}" >/dev/null 2>&1; then
    ok="$(jq -r '.ok' "${STATUS_FILE}")"
    reason="$(jq -r '.reason // "null"' "${STATUS_FILE}")"
    if [[ "${reason}" == "replica_credentials_missing" ]]; then
      log "in-container heartbeat wrote replica_credentials_missing (docker exec has no Infisical env); using host fallback"
    else
      log "in-container heartbeat verdict ok=${ok} reason=${reason} → ${STATUS_FILE}"
      exit 0
    fi
  fi
fi

log "in-container heartbeat did not refresh ${STATUS_FILE}; using host env-file LTX fallback on ${CONTAINER}"

run_ltx_via_process_env() {
  python3 - <<'PY' "${CONTAINER}" "${MAX_LTX_AGE_SECONDS}"
import datetime
import json
import os
import subprocess
import sys
import tempfile

container = sys.argv[1]
max_age = int(sys.argv[2])

top = subprocess.run(
    ["docker", "top", container, "-eo", "pid,cmd"],
    capture_output=True, text=True, timeout=30,
)
if top.returncode != 0:
    print("DOCKER_TOP_FAILED", file=sys.stderr)
    sys.exit(2)

host_pid = None
for line in top.stdout.splitlines()[1:]:
    parts = line.split(None, 1)
    if len(parts) < 2:
        continue
    if "litestream" in parts[1] and "replicate" in parts[1]:
        host_pid = parts[0]
        break
if not host_pid:
    print("NO_LITESTREAM_PID", file=sys.stderr)
    sys.exit(2)

try:
    with open(f"/proc/{host_pid}/environ", "rb") as fh:
        env_raw = fh.read()
except OSError as exc:
    print(f"ENV_READ_FAILED:{exc}", file=sys.stderr)
    sys.exit(3)

wanted = {
    "LITESTREAM_S3_BUCKET", "LITESTREAM_S3_ENDPOINT", "LITESTREAM_S3_REGION",
    "LITESTREAM_S3_ACCESS_KEY_ID", "LITESTREAM_S3_SECRET_ACCESS_KEY",
    "AWS_S3_BUCKET_NAME", "AWS_S3_ENDPOINT", "AWS_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
}
env_map = {}
for item in env_raw.split(b"\0"):
    if not item or b"=" not in item:
        continue
    k, _, v = item.partition(b"=")
    try:
        ks, vs = k.decode(), v.decode()
    except UnicodeDecodeError:
        continue
    if ks in wanted:
        env_map[ks] = vs

if not env_map.get("LITESTREAM_S3_BUCKET"):
    env_map["LITESTREAM_S3_BUCKET"] = env_map.get("AWS_S3_BUCKET_NAME", "")
if not env_map.get("LITESTREAM_S3_ENDPOINT"):
    env_map["LITESTREAM_S3_ENDPOINT"] = env_map.get("AWS_S3_ENDPOINT", "")
if not env_map.get("LITESTREAM_S3_REGION"):
    env_map["LITESTREAM_S3_REGION"] = env_map.get("AWS_REGION", "auto")
if not env_map.get("LITESTREAM_S3_ACCESS_KEY_ID"):
    env_map["LITESTREAM_S3_ACCESS_KEY_ID"] = env_map.get("AWS_ACCESS_KEY_ID", "")
if not env_map.get("LITESTREAM_S3_SECRET_ACCESS_KEY"):
    env_map["LITESTREAM_S3_SECRET_ACCESS_KEY"] = env_map.get("AWS_SECRET_ACCESS_KEY", "")

required = [
    "LITESTREAM_S3_BUCKET", "LITESTREAM_S3_ENDPOINT",
    "LITESTREAM_S3_ACCESS_KEY_ID", "LITESTREAM_S3_SECRET_ACCESS_KEY",
]
if any(not env_map.get(k) for k in required):
    print("CREDS_MISSING", file=sys.stderr)
    sys.exit(4)

def classify(stderr: str, rc: int) -> str:
    lower = stderr.lower()
    if rc == 124:
        return "list_timeout"
    if "tls handshake timeout" in lower or "i/o timeout" in lower:
        return "list_timeout"
    if "timed out" in lower or "deadline exceeded" in lower:
        return "list_timeout"
    return "list_error"

def newest_timestamp(payload: str):
    try:
        rows = json.loads(payload or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(rows, list):
        return None
    stamps = [row.get("timestamp") for row in rows if isinstance(row, dict) and row.get("timestamp")]
    return sorted(stamps)[-1] if stamps else None

env_path = None
try:
    with tempfile.NamedTemporaryFile(
        mode="w", prefix="litestream-env.", delete=False, dir="/tmp"
    ) as env_file:
        env_path = env_file.name
        for key in required + ["LITESTREAM_S3_REGION"]:
            value = env_map.get(key)
            if value:
                env_file.write(f"{key}={value}\n")
    os.chmod(env_path, 0o600)

    continuous_newest = None
    snapshot_newest = None
    saw_empty = False
    saw_timeout = False
    saw_error = False

    for level in (0, 1, 2, 3, 9):
        try:
            proc = subprocess.run(
                [
                    "docker", "exec", "--env-file", env_path, container,
                    "/app/bin/litestream", "ltx", "-json",
                    "-config", "/app/litestream.yml",
                    "-level", str(level),
                    "/data/prod.db",
                ],
                capture_output=True, text=True, timeout=70,
            )
        except subprocess.TimeoutExpired:
            saw_timeout = True
            continue
        except Exception:
            saw_error = True
            continue

        if proc.returncode == 0:
            if proc.stdout.strip() in ("", "[]"):
                saw_empty = True
                continue
            ts = newest_timestamp(proc.stdout)
            if not ts:
                saw_error = True
                continue
            if level == 9:
                snapshot_newest = ts
            elif continuous_newest is None or ts > continuous_newest:
                continuous_newest = ts
        else:
            kind = classify(proc.stderr, proc.returncode)
            if kind == "list_timeout":
                saw_timeout = True
            else:
                saw_error = True

    chosen = continuous_newest or snapshot_newest
    probe_reason = ""
    if continuous_newest:
        probe_reason = ""
    elif snapshot_newest:
        probe_reason = "snapshot_only"

    if not chosen:
        if saw_timeout:
            print("REASON=list_timeout", file=sys.stderr)
            sys.exit(7)
        if saw_empty and not saw_error:
            print("REASON=empty_ltx", file=sys.stderr)
            sys.exit(8)
        if saw_error:
            print("REASON=list_error", file=sys.stderr)
            sys.exit(9)
        print("REASON=no_parseable_ltx", file=sys.stderr)
        sys.exit(5)

    try:
        dt = datetime.datetime.fromisoformat(chosen.replace("Z", "+00:00"))
    except Exception:
        print(f"BAD_TS {chosen}", file=sys.stderr)
        sys.exit(6)

    age = int((datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds())
    ok = 0 <= age <= max_age
    print(f"LATEST={chosen}")
    print(f"AGE={age}")
    print(f"OK={1 if ok else 0}")
    if probe_reason:
        print(f"REASON={probe_reason}")
    sys.exit(0 if ok else 10)
finally:
    if env_path:
        try:
            os.unlink(env_path)
        except OSError:
            pass
PY
}

set +e
out="$(run_ltx_via_process_env 2>&1)"
rc=$?
set -e
log "ltx probe rc=${rc}"

if [[ "${rc}" -eq 0 ]]; then
  age="$(printf '%s\n' "${out}" | awk -F= '/^AGE=/{print $2; exit}')"
  age="${age:-0}"
  reason="$(printf '%s\n' "${out}" | awk -F= '/^REASON=/{print $2; exit}')"
  write_status_host "${STATUS_FILE}" true "${age}" "${reason}"
  log "replica healthy: age=${age}s → ${STATUS_FILE}"
  exit 0
fi

if [[ "${rc}" -eq 10 ]]; then
  age="$(printf '%s\n' "${out}" | awk -F= '/^AGE=/{print $2; exit}')"
  age="${age:-0}"
  reason="$(printf '%s\n' "${out}" | awk -F= '/^REASON=/{print $2; exit}')"
  if [[ -z "${reason}" ]]; then
    reason="ltx_age_exceeds_budget"
  fi
  write_status_host "${STATUS_FILE}" false "${age}" "${reason}"
  log "LTX age ${age}s exceeds budget (${reason})"
  exit 0
fi

reason="no_parseable_ltx"
case "${out}" in
  *NO_LITESTREAM_PID*) reason="litestream_not_running" ;;
  *CREDS_MISSING*) reason="replica_credentials_missing" ;;
  *REASON=list_timeout*) reason="list_timeout" ;;
  *REASON=empty_ltx*) reason="empty_ltx" ;;
  *REASON=list_error*) reason="list_error" ;;
  *REASON=no_parseable_ltx*) reason="no_parseable_ltx" ;;
  *BAD_TS*) reason="invalid_ltx_timestamp" ;;
  *ENV_READ_FAILED*) reason="replica_status_unreadable" ;;
esac
write_status_host "${STATUS_FILE}" false null "${reason}"
log "ERROR: probe failed (${reason})"
exit 0
