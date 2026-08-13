# 2026-08-13 — Infisical as the sole source of truth for env vars

Coolify held 25 environment-variable entries for `usage-monitor`. It now holds
8, all of which are the Infisical bootstrap itself. Everything else moved to,
or already lived in, the Infisical `usage-monitor` project (`prod`).

Owner directive: remove every variable from Coolify that can live in Infisical,
keeping only what is genuinely impossible to source from the vault.

## Why duplicated config was not harmless

`infisical run` **overrides** inherited process env, verified empirically:

```
COOLIFY_SERVER_STATS=SENTINEL infisical run … -- node -e 'print(env===SENTINEL)'
→ false
```

So any key present in both stores had its Coolify value silently ignored. That
is worse than redundant — it invites editing the copy that does nothing. It is
also exactly how the R2 kill switch stayed engaged: the switch lived in *both*
stores, so deleting only the Coolify entry would have changed nothing.

## What stays in Coolify, and why

| Key | Scope | Why it cannot move |
| --- | --- | --- |
| `INFISICAL_CLIENT_ID` | prod + preview | The credential that unlocks the vault. Chicken-and-egg. |
| `INFISICAL_CLIENT_SECRET` | prod + preview | Same. |
| `INFISICAL_PROJECT_ID` | prod + preview | *Which* vault to read. Cannot come from the vault. |
| `INFISICAL_ENV` | prod + preview | *Which* environment to read. Same. |

The last two are technically redundant — the Dockerfile bakes
`INFISICAL_ENV=prod` and `INFISICAL_UM_PROJECT_ID`, and both entrypoints
default to the same project id — but they are the address of the secret store,
they are not secrets, and keeping the bootstrap explicit is worth four rows.
Delete them if you would rather the repo be the only place that address exists.

## What moved into Infisical

`PORT`, `NODE_OPTIONS`, `COOLIFY_HOST`. None are secret; all are read well
after injection, so the vault is a fine home. (`PORT` is additionally baked
into the Dockerfile and Coolify's `ports_exposes`/healthcheck are configured
independently of it, so it has three fallbacks.)

## What was deleted outright

- **`LITESTREAM_EMERGENCY_DISABLE`, `R2_WRITES_DISABLED`** — from Coolify
  (prod + preview) *and* from Infisical. The R2 free-tier kill switch, engaged
  since 2026-08-04 with storage at 4.4% of the 10 GB free tier. See
  `2026-08-04-r2-free-tier-prune-and-killswitch.md` for the original incident
  and PR #1144 for why a config-sourced switch could never clear itself.
- **`INFISICAL_UM_CLIENT_ID` / `_SECRET`, `INFISICAL_UM_PROJECT_ID`** — dead
  fallbacks. `scripts/infisical-run.mjs` resolves `INFISICAL_CLIENT_ID` first,
  so the `UM_*` pair was never reached. Note the two entrypoints disagree on
  precedence: `start-with-infisical.sh` checks `AUTOMATION > UM > plain` while
  `infisical-run.mjs` uses `plain > UM > AUTOMATION > SHARED`. The plain pair
  was kept precisely because it is the one demonstrably in use.
- **`COOLIFY_SERVER_STATS`** — already in Infisical, and Infisical wins, so the
  Coolify copy was inert.
- **`SOURCE_COMMIT`** (preview) — a hardcoded SHA
  (`f90601ef`), months stale. Since `52a89e6d` the Dockerfile takes the real
  commit as a build arg, so this pin could only ever make a preview build
  misreport its revision. Same failure mode as the stale-pin incident that made
  `/api/ready` report a frozen revision.

Preview deployments are disabled on this app
(`is_preview_deployments_enabled: false`), so the preview-scope rows were inert
regardless.

## Tooling

`scripts/infisical-secrets-safe.sh` gained a `delete` subcommand. It defaults
to `--type shared`, because the CLI's default is `personal` and deleting the
personal copy of a shared secret silently succeeds while changing nothing. It
re-checks that the key is gone rather than trusting the exit code.

## Verification

Force-rebuilt and redeployed (a plain restart does **not** re-read Coolify env).
`/api/ready` after the cutover:

- `ok: true`, all backup layers green
- `primary` B2 active, replica ~2 min old
- `r2Historic.autoDisabled: **false**` — the kill switch is off for the first
  time since 2026-08-04
- weekly R2 archive present and healthy

121 secrets inject from Infisical at boot.
