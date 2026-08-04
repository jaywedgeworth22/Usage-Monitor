# Litestream WAL Replication (Oracle A1 production → Cloudflare R2)

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams
writes to `/data/prod.db` as LTX files.

**Production host:** Oracle Cloud A1 VM (Docker + Caddy, `deploy/oracle/README.md`)  
**Production replica:** Cloudflare R2 bucket **`usage-monitor-bucket`** on the
Jay / Usage Monitor Cloudflare account (`3a936805…`), object prefix
`api-usage-monitor/prod.db/`.

## What is gone (do not configure these)

| Former setup | Status |
|--------------|--------|
| **Coolify-hosted Garage** S3 (`usage-monitor-prod-v3`, Garage on the Coolify/Hetzner box) | **Deleted / retired.** Not production. Do not point litestream at a Coolify Garage endpoint. |
| **Render** app + its R2 lineage | Suspended rollback host only (`render.yaml`, `deploy/render/RETIRED-rollback.md`). Separate credentials/lineage — never dual-write with Oracle. |

Docs that still say “Garage on Coolify” as the live replica are **stale**; treat R2 as SoT.

> **0.5.x note:** Litestream 0.5 supports a **single replica per database** and stores
> **LTX files** (levels `0000`…`0009`), not the old `generations/` tree. Inspect with
> `litestream ltx`, not `litestream snapshots`.

## R2 free-tier auto-shutoff (70%) — this app owns the alert

Maintenance (`src/lib/r2-usage.ts`, every `fetch-all` / usage-maintenance tick) queries
Cloudflare GraphQL account analytics for R2 **storage**, **Class A**, and **Class B**
against the free tier (10 GiB / 1M Class A / 10M Class B). When any metric’s MTD share
or linear month-end projection reaches **70%**, the app:

1. Writes `/data/r2-disabled-70pct.flag` and sets `LITESTREAM_EMERGENCY_DISABLE` /
   `R2_WRITES_DISABLED` / clears `LITESTREAM_ACTIVE`.
2. Sends a **priority-1 Pushover** via **`PUSHOVER_USAGE_API_TOKEN`** (preferred) or
   `PUSHOVER_API_TOKEN`, with `PUSHOVER_USER_KEY`. Alerts come **from Usage Monitor**,
   not from Socratic.Trade’s multi-account watcher (that peer path is optional backup only).
3. Stops **R2** litestream: startup skips `litestream replicate` when the flag is set;
   runtime health reports `r2_free_tier_disabled`.

Requires analytics credentials (Account Analytics Read):

- `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN`, **or**
- `CLOUDFLARE_JAY_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_JAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN`

Without those credentials the check reports `metricsSource: unavailable` and **does
not** auto-disable (it will never fake local DB size as R2 usage). **2026-08-04
incident:** Infisical had S3 write keys but **no** GraphQL analytics token, so the
kill-switch never armed while R2 climbed past 10 GiB — Socratic’s peer monitor was
the only alert.

### Resume after prune

1. Prune or wait until account storage is well under 70% (see ops note below).
2. Delete `/data/r2-disabled-70pct.flag` (and optional `r2-emergency-alert-sent.flag`).
3. Clear `LITESTREAM_EMERGENCY_DISABLE` / `R2_WRITES_DISABLED` if set in Infisical.
4. Restart the app container so `start-with-litestream.sh` starts `litestream replicate` again.

## Why R2 can spike with “no one using the UI”

Litestream is independent of dashboard traffic. Production continuously:

- Accepts **ingest/OTLP/telemetry** from peer apps (Socratic, Congress, etc.).
- Runs **cron / maintenance** polls and SQLite writes.
- Compacts LTX; **level `0009` full-DB LTX files are ~0.35–0.40 GiB each**.

On 2026-08-04 the bucket went from ~4 GiB → **~10.5 GiB in ~2 hours** because many
full-size LTX objects were uploaded (dozens of ~375 MiB files), not because an
operator opened the UI. Short **snapshot retention** (48h) + free-tier kill-switch
+ analytics credentials are what bound that.

## Config files & scripts

- `scripts/fetch-litestream.sh` — build-time pinned litestream binary → `./bin/litestream`.
- `litestream.yml` — `/data/prod.db` → S3-type replica from `LITESTREAM_S3_*`;
  **`snapshot.retention: 48h`**, `interval: 24h` (cut from 168h after the free-tier breach).
- `scripts/start-with-litestream.sh` — restore-if-empty → migrate → `litestream replicate -exec "npm start"`;
  skips replicate when the R2 kill flag is set.
- `scripts/backup-sqlite-before-migrate.mjs` — same-disk pre-migration snapshot.
- `scripts/litestream-restore.sh` — manual DR restore inside the app container.
- `deploy/oracle/replica-status-probe.sh` — host timer proving the replica advances
  (feeds `/api/ready` backup check).

## Production setup (Oracle → Cloudflare R2)

Runtime config: Infisical `usage-monitor` project, env `prod` (see `DEPLOY.md`).

```
LITESTREAM_S3_BUCKET=usage-monitor-bucket
LITESTREAM_S3_REGION=auto
LITESTREAM_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
LITESTREAM_S3_ACCESS_KEY_ID=...
LITESTREAM_S3_SECRET_ACCESS_KEY=...
LITESTREAM_REQUIRED=true

# Free-tier monitor (required for auto-kill + UM-owned Pushover)
CLOUDFLARE_ACCOUNT_ID=<jay-account-id>          # or CLOUDFLARE_JAY_ACCOUNT_ID / R2_USAGE_ACCOUNT_ID
CLOUDFLARE_JAY_API_TOKEN=<analytics-read-token> # or R2_USAGE_API_TOKEN
PUSHOVER_USER_KEY=...
PUSHOVER_USAGE_API_TOKEN=...                    # preferred; falls back to PUSHOVER_API_TOKEN
```

`AWS_*` unified names are normalized into `LITESTREAM_S3_*` by the startup wrapper.

All four of bucket/endpoint/access-key-id/secret-access-key must be set together.
Partial config fails closed. Multipart concurrency is 1 in `litestream.yml` for
reliable uploads on constrained links.

## Ops: prune old LTX when over free tier

Litestream 0.5 does not use a `generations/` tree. To reclaim space quickly:

1. List `s3://usage-monitor-bucket/api-usage-monitor/prod.db/` (R2 S3 API).
2. Per level directory (`0000`…`0009`), keep the **newest tip** LTX (highest end
   TXID / latest mtime); delete the rest.
3. Or delete objects older than the configured retention after GC has failed to
   keep up with a burst.

Live DB on Oracle remains the source of truth; a thin R2 tip is enough for
recent PITR until the next full seed. After a large prune, expect a re-seed
burst — engage the kill-switch until storage is stable if free-tier headroom
is tight.

## Rollback host only (Render)

The suspended Render service keeps a **separate** R2 lineage and credentials.
Never reverse DNS onto Render’s stale DB without first restoring a verified
Oracle/R2 lineage and transferring writer authority deliberately.
