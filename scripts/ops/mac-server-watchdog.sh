#!/usr/bin/env bash
# Mac Server Watchdog & Telemetry Ingest Script
# Sends Mac host health metrics to POST /api/ingest/mac-heartbeat on Usage-Monitor
# and performs self-healing checks on critical local processes.

set -euo pipefail

INGEST_URL="${INGEST_URL:-https://usage.jays.services/api/ingest/mac-heartbeat}"
SECRETS_FILE="/Users/jay/.secrets/global-api-keys"

if [[ -f "$SECRETS_FILE" ]]; then
  # Extract USAGE_INGEST_TOKEN if available
  TOKEN=$(grep "^USAGE_INGEST_TOKEN=" "$SECRETS_FILE" | cut -d'=' -f2 | tr -d '"' || true)
fi

TOKEN="${USAGE_INGEST_TOKEN:-${TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "Error: USAGE_INGEST_TOKEN not found in environment or $SECRETS_FILE" >&2
  exit 1
fi

HOSTNAME=$(hostname -s 2>/dev/null || echo "MacBook")
OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "macOS")
ARCH=$(uname -m 2>/dev/null || echo "arm64")

# Calculate CPU Usage % (via ps / sysctl or top)
CPU_USAGE=$(ps -A -o %cpu | awk '{s+=$1} END {printf "%.1f", s / 8}') # 8 cores normalizer

# Calculate Memory Usage % (via vm_stat)
PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
FREE_PAGES=$(vm_stat | awk '/Pages free/ {print $3}' | tr -d '.')
ACTIVE_PAGES=$(vm_stat | awk '/Pages active/ {print $3}' | tr -d '.')
INACTIVE_PAGES=$(vm_stat | awk '/Pages inactive/ {print $3}' | tr -d '.')
WIRED_PAGES=$(vm_stat | awk '/Pages wired/ {print $4}' | tr -d '.' || echo 0)
TOTAL_MEM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 17179869184)

USED_MEM_BYTES=$(( (ACTIVE_PAGES + INACTIVE_PAGES + WIRED_PAGES) * PAGE_SIZE ))
MEM_USAGE=$(awk -v used="$USED_MEM_BYTES" -v total="$TOTAL_MEM_BYTES" 'BEGIN {printf "%.1f", (used/total)*100}')

# Calculate Disk Usage %
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | tr -d '%')

# Calculate Uptime Seconds
UPTIME_SEC=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{print $2}' | awk -v now="$(date +%s)" '{printf "%d", now - $1}')

# Check Process Statuses
check_process() {
  local name="$1"
  if pgrep -x "$name" >/dev/null 2>&1 || pgrep -f "$name" >/dev/null 2>&1; then
    echo "running"
  else
    echo "stopped"
  fi
}

OLLAMA_STATUS=$(check_process "ollama")
LITESTREAM_STATUS=$(check_process "litestream")
DOCKER_STATUS=$(check_process "Docker")
AGENT_SYNC_STATUS=$(check_process "agent-sync")

# Build JSON Payload
PAYLOAD=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "osVersion": "$OS_VERSION",
  "arch": "$ARCH",
  "cpuUsagePct": $CPU_USAGE,
  "memoryUsagePct": $MEM_USAGE,
  "diskUsagePct": $DISK_USAGE,
  "uptimeSeconds": $UPTIME_SEC,
  "processes": {
    "ollama": "$OLLAMA_STATUS",
    "litestream": "$LITESTREAM_STATUS",
    "docker": "$DOCKER_STATUS",
    "agent-sync": "$AGENT_SYNC_STATUS"
  }
}
EOF
)

# Post Heartbeat
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$INGEST_URL" || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mac heartbeat posted successfully (CPU: ${CPU_USAGE}%, RAM: ${MEM_USAGE}%, Disk: ${DISK_USAGE}%)."
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: Mac heartbeat failed with HTTP status $HTTP_CODE" >&2
fi
