#!/usr/bin/env bash
# Production entrypoint wrapper:
#   - When Infisical universal-auth bootstrap credentials are present, inject
#     secrets from the usage-monitor Infisical project and then start.
#   - Otherwise run start-with-litestream.sh with the process environment as-is
#     (Docker Compose env_file materialization path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

has_bootstrap=false
if [[ -n "${INFISICAL_AUTOMATION_CLIENT_ID:-${INFISICAL_UM_CLIENT_ID:-${INFISICAL_CLIENT_ID:-}}}" &&
  -n "${INFISICAL_AUTOMATION_CLIENT_SECRET:-${INFISICAL_UM_CLIENT_SECRET:-${INFISICAL_CLIENT_SECRET:-}}}" ]]; then
  has_bootstrap=true
fi

if [[ "${has_bootstrap}" == "true" ]] && command -v infisical >/dev/null 2>&1; then
  export INFISICAL_ENV="${INFISICAL_ENV:-prod}"
  export INFISICAL_UM_PROJECT_ID="${INFISICAL_UM_PROJECT_ID:-${INFISICAL_PROJECT_ID:-${INFISICAL_APP_PROJECT_ID:-}}}"
  echo "[start-with-infisical] injecting secrets from Infisical (env=${INFISICAL_ENV}, project=${INFISICAL_UM_PROJECT_ID})"
  exec node "${REPO_ROOT}/scripts/infisical-run.mjs" -- bash "${REPO_ROOT}/scripts/start-with-litestream.sh"
fi

echo "[start-with-infisical] no Infisical bootstrap credentials; using process env"
exec bash "${REPO_ROOT}/scripts/start-with-litestream.sh"
