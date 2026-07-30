# Deployment Guide

**Production is the Oracle Cloud `VM.Standard.A1.Flex` host** running Docker +
Caddy behind Cloudflare at `usage.jays.services`. The authoritative runbook —
installation, the auto-deploy timer, preflight gates, deploy-transaction
acceptance, backup monitoring, and rollback rules — is
**[`deploy/oracle/README.md`](deploy/oracle/README.md)**. This file records the
operational invariants every operator and agent must know, plus the
environment variable reference.

The former Render deployment is **retired and suspended as a rollback host
only**; its historical runbook lives in
[`deploy/render/RETIRED-rollback.md`](deploy/render/RETIRED-rollback.md) and
`render.yaml` is kept functional solely so that host can be revived in a
deliberate rollback.

## Operational invariants

1. **Sole writer.** Exactly one app container may run against the SQLite
   database at any time. Only `usage-monitor.service` starts the app (the
   container's Docker restart policy is permanently `no` so the daemon can
   never start a writer before the `/data` block volume mounts), and the
   deploy transaction stops the old writer before accepting the new one.
   Never run a second instance — including a Render resume — against
   production data.
2. **Secrets live only on the host.** Runtime secrets exist solely in
   `/etc/usage-monitor/usage-monitor.env` (root-owned, mode 0600). Non-secret
   host settings live in `/etc/usage-monitor/host.env`. No production SSH key
   or cloud credential is stored in GitHub; the deploy model is pull-based.
3. **Backups replicate to the Garage bucket `usage-monitor-prod-v3`.**
   Litestream continuously replicates `/data/prod.db` there; the deploy
   preflight hard-fails if any other bucket is configured. Layered backup
   story: same-disk pre-migration snapshots → deploy-time offline snapshots
   (up to five retained) → Litestream/Garage PITR with 15-minute external
   verification and weekly restore drills.
4. **Deploys are automatic and gated.** The
   `usage-monitor-auto-deploy.timer` polls GitHub once per minute and deploys
   only when all preflight gates pass: exact `main` SHA with valid signature,
   merged-PR provenance, green GitHub Actions (`verify`, `gitleaks`,
   `Analyze JavaScript and TypeScript`), healthy current database / sole
   scheduler / Garage replica / `/data` headroom / public readiness, and the
   Render retirement proof (service user-suspended, auto-deploy disabled,
   `USAGE_SCHEDULER_ENABLED=false`, verified live through Render's API).
   `/etc/usage-monitor/auto-deploy.paused` freezes deployments while present.
5. **Rollback never restores an old database over new writes.** Automatic
   rollback changes code/image only. A full host rollback requires quiescing
   Oracle and restoring the latest verified Garage lineage before
   transferring writer authority — never just re-point DNS at Render's stale
   database.

## Verify a deployment

1. `curl -fsS https://usage.jays.services/api/health | jq` — confirm the
   expected `revision`.
2. `curl -fsS "https://usage.jays.services/api/ready?strict=1" | jq` —
   confirm database, scheduler, startup, and backup checks; observability
   blocks (`disk`, `budgetControls`, `admission`, `usageReadToken`) never
   gate `ok`. A non-ready dependency returns 503 with `strict=1`.
3. On the host: `sudo cat /var/lib/usage-monitor-deploy/current.json` for the
   deployment receipt, and
   `sudo journalctl -u usage-monitor-auto-deploy.service --since today` for
   gate decisions.
4. Visit https://usage.jays.services and log in at `/login` with
   `DASHBOARD_PASSWORD` from `/etc/usage-monitor/usage-monitor.env`.

## Environment variables

All of these are set in `/etc/usage-monitor/usage-monitor.env` (or
`host.env` for the non-secret hostname/revision). `.env.example` documents
defaults and valid values.

- `DATABASE_URL` — `file:/data/prod.db` on the dedicated block volume (not a
  secret, just a file path)
- `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` (defaults to `3`, valid `1`-`10`;
  newest verified local snapshots retained under
  `/data/.pre-migration-backups` before startup schema synchronization)
- `ENCRYPTION_KEY` (64-char hex)
- `CRON_SECRET` (the `/api/cron/fetch-all` route still checks this, kept as
  an authenticated manual-trigger/debug endpoint even though nothing calls it
  on a schedule anymore)
- `USAGE_INGEST_TOKEN` (copy this into reporting apps as their usage monitor
  ingest token — this is also the token Claude Code's OTLP exporter
  authenticates with against `POST /api/otlp/v1/metrics`, see AGENTS.md's
  "Claude Code OTLP ingest" section)
- `USAGE_READ_TOKEN` (**required in production** — the deploy preflight
  hard-fails without it; read-only token for `/api/budget-status` and
  `GET /api/subscriptions`)
- `DASHBOARD_PASSWORD` (gates `/login` and all non-ingest routes)
- `SESSION_SECRET` (session cookies are HKDF-derived from this instead
  of `DASHBOARD_PASSWORD`, so a leaked session token can't be used to verify password guesses and the
  password can be rotated without invalidating existing sessions. Setting or changing it invalidates
  all existing sessions at once (the owner just re-logs in); it does not revoke individual sessions.)
- `SENTRY_READ_TOKEN` (optional; enables the read-only Sentry Health dashboard card, an org-auth
  token or internal integration token with `project:read`/`event:read` scope — never sent to the
  client, absent by default)
- `SENTRY_ORG` (optional; Sentry org slug for the Health card, defaults to `jays-services`)
- `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` / `ALERT_RESEND_API_KEY` +
  `ALERT_EMAIL_FROM` + `ALERT_EMAIL_TO` / `ALERT_PAGERDUTY_ROUTING_KEY` (optional delivery
  destinations; Resend needs all three email values)
- `ALERT_MIN_SEVERITY` (optional; `info`, `warning`, or `critical`; defaults to `warning`)
- `ALERT_REMINDER_HOURS` (optional; defaults to `24`, applied independently per destination)
- `ALERT_DELIVERY_TIMEOUT_MS` / `ALERT_DELIVERY_MAX_ATTEMPTS` /
  `ALERT_DELIVERY_RETRY_BASE_MS` (optional; defaults `10000` / `3` / `250`; timeout max 60s,
  attempts max 5, and exponential waits cap at 5s)
- `USAGE_SNAPSHOT_RAW_RETENTION_DAYS` (optional; defaults to `45`, after which raw snapshots are
  rolled up daily and pruned)
- `EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS` (optional; defaults to `90`; current UTC-month events
  are always retained because `/api/budget-status` reads them directly)
- `EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS` (legacy compatibility setting, still reported
  by maintenance results but no longer used to delete tombstones; rolled-up idempotency keys are
  retained permanently so late producer retries cannot be counted twice)
- `DATA_RETENTION_ENABLE_VACUUM` (optional, defaults off; full SQLite compaction
  is operator-only because it takes an exclusive lock and rewrites the database)
- `BUDGET_STATUS_CACHE_TTL_MS` (optional; defaults to `60000`; stale-while-revalidate TTL for
  `computeBudgetStatus`, the sole read path for `/api/providers`, `/api/projects`, and
  `/api/budget-status`'s combined poll+pushed+subscription spend. A request always gets the last
  computed value immediately; a background refresh runs once it's older than this)
- `DATA_RETENTION_DISABLE_VACUUM` (legacy override; any true value prevents the
  opt-in compaction above)
- `ADAPTER_HTTP_TIMEOUT_MS` / `ADAPTER_PROVIDER_TIMEOUT_MS` (optional bounded
  upstream-request and per-provider polling budgets)
- `READY_DISK_WARN_FREE_BYTES` (optional; free-bytes warn threshold for the
  observability-only `checks.disk` block in `/api/ready`, default 5 GiB —
  aligned with the deploy preflight's `MIN_DATA_FREE_BYTES`)
- `STARTUP_WRAPPER_REQUIRED` (optional opt-out; in production,
  `/api/ready?strict=1` fails unless the process booted through
  `scripts/start-with-litestream.sh`. Set `false` only for disposable
  throwaway containers that never write to SQLite)
- `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED` (optional, defaults to `false`;
  one-time create-only bootstrap for the fixed current SocraticTrade.com Gemini
  provider into the fixed ST `prod` `/` `GEMINI_API_KEY`). It never updates or
  deletes an Infisical secret. Enable only for the reviewed migration run and
  disable immediately after its sanitized result is observed.
- `INFISICAL_ST_PRIMARY_SYNC_ENABLED` (optional, defaults to `false`) plus the
  dedicated `INFISICAL_ST_PRIMARY_CLIENT_ID` / `_CLIENT_SECRET`. This read-only
  identity is fixed to the SocraticTrade.com Infisical project, `prod`, and
  `/usage-monitor/st-primary/v1`; it cannot be redirected with project/path env
  variables. Enable only after the writer has published a reviewed strict
  `BRIDGE_MANIFEST_V1` complete set.
- `USAGE_SCHEDULER_ENABLED` (optional, defaults to `true`; emergency isolation
  switch for the in-process provider polling scheduler). Setting it to `false`
  stops automatic provider snapshots but does not disable pushed usage/OTLP
  ingest. Use only to isolate scheduler/SQLite contention, and restore `true`
  only after a complete provider tick plus DB-backed ingest/replay smoke succeeds.
- `OTLP_METRICS_INGEST_ENABLED` (optional, defaults to `true`; emergency
  isolation switch for database-writing `POST /api/otlp/v1/metrics`). Setting it
  to `false` returns authenticated requests admitted by the IP limiter `503`
  plus `Retry-After: 300` before reading their body or touching SQLite; excess
  requests receive `429` with the same backoff. Generic `/api/ingest/usage`
  remains available. Restore `true` only after the database stays healthy and a
  controlled OTLP ingest/replay succeeds.
- `LITESTREAM_S3_*` (Garage replica credentials; set all four required values
  together or none—partial configuration fails startup. Production targets
  bucket `usage-monitor-prod-v3`; see `litestream.yml` and `docs/litestream.md`)
- `LITESTREAM_REQUIRED` (production: `true`; readiness fails if replication
  is absent or the replica side-channel is unhealthy)

## SSL/TLS
- Cloudflare proxy: enabled for `usage.jays.services`
- Cloudflare terminates public TLS; Caddy renews its origin certificate via
  HTTP-01 (TLS-ALPN disabled) and keeps ports 80/443 reachable
- HTTP is redirected to HTTPS; application responses also set HSTS, CSP,
  framing, MIME-sniffing, referrer, and permissions headers

## SQLite backup layers

Every startup with an existing DB runs
`scripts/backup-sqlite-before-migrate.mjs` before `migrate-safe.mjs`. It opens
the source read-only, uses SQLite's Online Backup API (safe with WAL), checks
the destination with `PRAGMA integrity_check`, atomically promotes only a
verified file, and retains the newest
`SQLITE_PRE_MIGRATION_BACKUP_RETENTION` snapshots under
`/data/.pre-migration-backups`. Failure to create, verify, or bound the
backup stops production startup before migration. These same-disk snapshots
are schema rollback protection, not protection from disk loss.

Every deploy transaction additionally keeps the previous full-SHA image and
up to five verified offline SQLite snapshots for automatic code rollback.

[Litestream](https://litestream.io/) continuously replicates `/data/prod.db`
to the Garage bucket `usage-monitor-prod-v3` with transaction-aware restore
points (7-day snapshot retention, 24 h snapshot interval — see
`litestream.yml`). The external singleton at
`/Users/jay/apps/fleet-sentry-monitor/monitor.py` verifies replica freshness
and restorability every 15 minutes and runs a weekly full-integrity restore
drill (see "Backup monitoring" in `deploy/oracle/README.md`). Full setup,
verification, and disaster-recovery restore steps live in
`docs/litestream.md`. Relevant files: `scripts/fetch-litestream.sh`
(build-time binary download), `scripts/start-with-litestream.sh` (startup
wrapper), `scripts/litestream-restore.sh` (manual restore).

## Release-time data maintenance

Do not add the Claude cumulative-cost repair or subscription seed to automatic
startup. Both require production-specific review that an idempotency marker
cannot replace. See `docs/release-maintenance.md` for the evidence and the
requirements for any future marker-driven task.
