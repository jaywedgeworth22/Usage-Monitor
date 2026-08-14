#!/usr/bin/env bash
# Offline checks for scripts/cf-token-map.sh.  Never talks to Infisical or Cloudflare.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/cf-token-map.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

bash -n "$SRC" || fail "bash -n"

# The token variable must never be printed.
if grep -nE 'echo +"\$VAL"|printf +"%s" +"\$VAL"|echo +\$VAL' "$SRC" >/dev/null; then
  fail "script would print \$VAL"
fi

# Login must not put the Infisical client secret on argv.
if grep -nE -- '--client-secret=' "$SRC" >/dev/null; then
  fail "login still passes --client-secret on argv"
fi

# Bearer header must come from a 0600 temp file, not curl argv.
if grep -nE "Authorization: Bearer \\\$VAL" "$SRC" | grep -v 'printf' >/dev/null; then
  fail "Bearer token interpolated outside the header-file write"
fi

grep -q 'CLOUDFLARE_FLEET_API_TOKEN' "$SRC" || fail "missing fleet token name"
grep -q 'CLOUDFLARE_JAY_API_TOKEN' "$SRC" || fail "missing JAY token name"
grep -qi 'Never prints a' "$SRC" || fail "missing value-blind banner"

printf 'ok  cf-token-map offline checks\n'
