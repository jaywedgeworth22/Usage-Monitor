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
set -euo pipefail
umask 022
export LC_ALL=C

# Coolify application uuid for Usage Monitor (AGENTS.md / Coolify).
readonly APP_UUID_PREFIX="${USAGE_MONITOR_COOLIFY_UUID:-yagelvqux9e8l1kztif7bf2o}"
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

# Prefer in-container heartbeat script when present (has Infisical env via
# process re-export). Fall back to host-PID environ LTX listing.
run_in_container_heartbeat() {
  docker exec "${CONTAINER}" bash /app/scripts/replica-status-heartbeat.sh --once 2>/dev/null
}

run_ltx_via_process_env() {
  python3 - <<'PY' "${CONTAINER}" "${MAX_LTX_AGE_SECONDS}"
import datetime, re, subprocess, sys

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

export_args = []
for k in required + ["LITESTREAM_S3_REGION"]:
    if env_map.get(k):
        export_args.extend(["-e", f"{k}={env_map[k]}"])

latest = None
for level in range(0, 6):
    r = subprocess.run(
        ["docker", "exec", *export_args, container,
         "/app/bin/litestream", "ltx",
         "-config", "/app/litestream.yml",
         "-level", str(level),
         "/data/prod.db"],
        capture_output=True, text=True, timeout=70,
    )
    if r.returncode != 0:
        continue
    times = []
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) == 5 and re.fullmatch(r"[0-9]+", parts[0]):
            times.append(parts[4])
    if times:
        latest = sorted(times)[-1]
        break

if not latest:
    print("NO_LTX", file=sys.stderr)
    sys.exit(5)

try:
    dt = datetime.datetime.fromisoformat(latest.replace("Z", "+00:00"))
except Exception:
    print(f"BAD_TS {latest}", file=sys.stderr)
    sys.exit(6)

age = int((datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds())
ok = 0 <= age <= max_age
print(f"LATEST={latest}")
print(f"AGE={age}")
print(f"OK={1 if ok else 0}")
sys.exit(0 if ok else 10)
PY
}

if run_in_container_heartbeat; then
  if [[ -f "${STATUS_FILE}" ]]; then
    # Reject a prior false verdict from an older probe if heartbeat rewrote ok.
    if jq -e '.ok == true' "${STATUS_FILE}" >/dev/null 2>&1; then
      log "in-container heartbeat OK → ${STATUS_FILE}"
      exit 0
    fi
  fi
fi

log "using host-PID environ LTX listing on ${CONTAINER}"
set +e
out="$(run_ltx_via_process_env 2>&1)"
rc=$?
set -e
log "ltx probe rc=${rc}"

if [[ "${rc}" -eq 0 ]]; then
  age="$(printf '%s\n' "${out}" | awk -F= '/^AGE=/{print $2; exit}')"
  age="${age:-0}"
  write_status_host "${STATUS_FILE}" true "${age}" ""
  log "replica healthy: age=${age}s → ${STATUS_FILE}"
  exit 0
fi

if [[ "${rc}" -eq 10 ]]; then
  age="$(printf '%s\n' "${out}" | awk -F= '/^AGE=/{print $2; exit}')"
  age="${age:-0}"
  write_status_host "${STATUS_FILE}" false "${age}" "ltx_age_exceeds_budget"
  log "LTX age ${age}s exceeds budget"
  exit 0
fi

reason="no_parseable_ltx"
case "${out}" in
  *NO_LITESTREAM_PID*) reason="litestream_not_running" ;;
  *CREDS_MISSING*) reason="replica_credentials_missing" ;;
  *NO_LTX*) reason="no_parseable_ltx" ;;
  *BAD_TS*) reason="invalid_ltx_timestamp" ;;
  *ENV_READ_FAILED*) reason="replica_status_unreadable" ;;
esac
write_status_host "${STATUS_FILE}" false null "${reason}"
log "ERROR: probe failed (${reason}): ${out}"
exit 1
