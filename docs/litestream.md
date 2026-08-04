# Litestream WAL Replication (Oracle A1 production; Render = retired rollback host)

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams
writes to `/data/prod.db` as LTX files. **Production is the Oracle A1 VM**
(Docker + Caddy, see `deploy/oracle/README.md`), replicating to the Coolify
Garage S3 bucket `usage-monitor-prod-v3`. The suspended Render service is kept
only as a deliberate, owner-directed rollback host (see `render.yaml`'s header
and `deploy/render/RETIRED-rollback.md`); its Cloudflare R2 bucket is a
separate replica lineage so the two hosts can never write to the same replica.

**Opt-in, with fail-closed configuration.** With `LITESTREAM_S3_*` unset and
`LITESTREAM_REQUIRED=false`, `scripts/start-with-litestream.sh` still creates
and integrity-checks a bounded local snapshot of an existing SQLite database
before `migrate-safe.mjs`, then starts without a litestream process. Setting
the four required `LITESTREAM_S3_*` env vars
(BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY; REGION is optional) turns
replication (and restore-on-fresh-disk) on. Partial credentials, an unverified
local pre-migration snapshot, or a configured replica with a missing/unverified
binary stop startup. Production runs `LITESTREAM_REQUIRED=true`, so an
entirely missing replica also stops startup and makes `/api/ready` fail.

### R2 free-tier auto-shutoff (70%)

Maintenance (`src/lib/r2-usage.ts`) queries Cloudflare GraphQL account analytics
each tick for R2 **storage**, **Class A**, and **Class B** against the forever
free tier (10 GiB / 1M Class A / 10M Class B). When any metric's MTD share or
linear month-end projection reaches **70%**, the app:

1. Writes `/data/r2-disabled-70pct.flag` and sets `LITESTREAM_EMERGENCY_DISABLE`
   / `R2_WRITES_DISABLED`.
2. Sends a priority-1 Pushover alert (retried until delivered).
3. Stops **only R2-backed** Litestream: startup skips R2 replication when the
   flag is present, and the R2 sibling-process watcher SIGTERMs litestream
   mid-cycle. **Garage / non-R2 endpoints are never killed** by this switch.

Requires `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN` (or
`CLOUDFLARE_JAY_*` / `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`) with
Account Analytics Read. Without credentials the check reports
`metricsSource: unavailable` and does **not** auto-disable (it will not fake
local DB size as R2 usage).

> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**. It
> also replaced the `snapshots`/`generations` model with **LTX files** — inspect them
> with `litestream ltx`, not `litestream snapshots`.

## How it fits into this repo

- `scripts/fetch-litestream.sh` — runs at image build time (Oracle Dockerfile;
  formerly `render.yaml`'s `buildCommand`). Downloads a pinned Litestream
  release (currently v0.5.13, selecting linux-x86_64 or linux-arm64 from the
  build host) into `./bin/litestream`, verifying its sha256 against a pin in
  the script. Idempotent (skips if the right version is already there) and safe
  to run even when replication is never enabled — the binary just sits unused.
- `litestream.yml` — the replica config: `/data/prod.db`, single S3-type replica
  populated entirely from `LITESTREAM_S3_*` env vars, `retention: 168h` /
  `snapshot-interval: 24h` (7 days of history; reduced from 720h/30d on 2026-07-21
  after Garage on the shared Hetzner 75G disk grew past 14 GiB in a few days),
  copied from Socratic.Trade's config.
- `scripts/start-with-litestream.sh` — the container entrypoint. If all four
  required `LITESTREAM_S3_*` vars are set and `bin/litestream` exists: restores
  first if `/data/prod.db` doesn't exist yet (fresh disk or disaster recovery).
  In both enabled and disabled modes it then runs
  `backup-sqlite-before-migrate.mjs` and `migrate-safe.mjs` in that order.
  Enabled mode finally `exec`s `litestream replicate -exec "npm start"`; disabled
  mode `exec`s `npm start` directly.
- `prisma.config.ts` — declares Litestream's `_litestream_seq` and
  `_litestream_lock` tables as externally managed. Startup schema sync must
  preserve their exact schema and state; `migrate-safe.mjs` never retries with
  Prisma's broad `--accept-data-loss` flag.
- `scripts/backup-sqlite-before-migrate.mjs` — transaction-consistent SQLite
  Online Backup API snapshot plus `PRAGMA integrity_check`, private file modes,
  atomic promotion, and bounded same-disk retention. It is the immediate schema
  rollback layer; Litestream remains the off-disk PITR layer.
- `scripts/litestream-restore.sh` — manual disaster-recovery restore to a
  scratch path, run inside the production app container (see below).
- `deploy/oracle/replica-status-probe.sh` — 10-minute host timer that proves
  the replica is actually advancing and writes the heartbeat consumed by
  `/api/ready`'s backup check (see "Replica heartbeat" in
  `deploy/oracle/README.md`). Without it, a required backup reports
  `env_active_unverified` and strict readiness fails.

## Production setup (Oracle / Garage)

Runtime config lives in the Infisical `usage-monitor` project (env `prod`) as
the sole source of truth — see `DEPLOY.md` "Runtime env: Infisical is the
source of truth" and `deploy/oracle/README.md`. Set there:

```
LITESTREAM_S3_BUCKET=usage-monitor-prod-v3
LITESTREAM_S3_REGION=garage
LITESTREAM_S3_ENDPOINT=https://<coolify-garage-host>:9443
LITESTREAM_S3_ACCESS_KEY_ID=...
LITESTREAM_S3_SECRET_ACCESS_KEY=...
LITESTREAM_REQUIRED=true
```

All four of bucket/endpoint/access-key-id/secret-access-key must be set together.
The startup wrapper rejects partial configuration, and it rejects full
configuration when the verified binary is unavailable. `LITESTREAM_S3_REGION`
is optional for R2 and can be left unset: Litestream
expands config env vars with Go's `os.Getenv` (not a shell, so `${VAR:-default}` is not
supported), and with an S3 endpoint set an empty region falls back to `us-east-1`, which
R2 accepts for SigV4. Set it to `auto` only if you prefer to be explicit.

For Oracle, Infisical sets both `LITESTREAM_S3_*` and the unified `AWS_*` secret names
(AWS_S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME, AWS_REGION).
The startup wrapper normalizes `AWS_*` into `LITESTREAM_S3_*` for `litestream.yml` expansion.
Point `LITESTREAM_S3_ENDPOINT` / `AWS_S3_ENDPOINT` to Cloudflare R2 (`https://<account-id>.r2.cloudflarestorage.com`),
bucket `usage-monitor-prod-v3`, with region `auto`.

All four of bucket/endpoint/access-key-id/secret-access-key must be set
together. The startup wrapper rejects partial configuration, and it rejects
full configuration when the verified binary is unavailable.

The S3 uploader is intentionally limited to one multipart part at a time in
`litestream.yml`. This keeps each minimum-size S3 part within the reverse
proxy's request deadline on slower cross-region links; normal LTX uploads are
small, so reliability is more important than initial-seed parallelism here.
The deployed Garage router also uses the dedicated TLS entrypoint on port 9443,
whose request-body read timeout is five minutes. Keep Oracle's
`LITESTREAM_S3_ENDPOINT` on that `:9443` URL. Do not raise the shared HTTPS
entrypoint timeout for every Coolify workload just to accommodate backup
uploads.

Changing any of these values: edit them in Infisical, run
`sudo /usr/local/sbin/usage-monitor-env-sync` (or wait for the 15-minute
timer), then recreate the container (`sudo systemctl restart usage-monitor`)
or let the next deploy pick them up. There is no dashboard that "triggers a
redeploy" on Oracle.

### Verify

From the Oracle VM:

```bash
# Config parses + replica is wired:
sudo docker exec oracle-app-1 /app/bin/litestream databases -config /app/litestream.yml

# LTX files actually landed in Garage (tip listing; avoid `-level all`,
# which lists thousands of compacted objects and can time out):
sudo docker exec oracle-app-1 /app/bin/litestream ltx -config /app/litestream.yml /data/prod.db

# The readiness heartbeat is fresh:
cat /data/.litestream-replica-status.json
curl -fsS https://usage.jays.services/api/ready?strict=1 | jq .checks.backup
```

In `sudo docker logs oracle-app-1`, look for the
`[start-with-litestream] replication ENABLED` line and a
`[sqlite-pre-migration-backup] verified ...` line at boot, followed by
litestream's own `replicating to type=s3 bucket=...` and periodic
`ltx file uploaded` / `replica sync` lines. If instead you see
`[start-with-litestream] replication DISABLED`, all required `LITESTREAM_S3_*`
vars are unset and the boot must be treated as misconfigured (production
requires them). Partial values or a missing binary are startup errors; check
`fetch-litestream.sh` and startup logs.

Confirm `/api/ready` reports `checks.backup.required=true`,
`checks.backup.active=true`, and `checks.backup.replicaOk=true` (the heartbeat
side-channel; `envOnly:true` means the probe is not writing its status file
and strict readiness will fail).

## Rollback host only (Render / R2)

The suspended `api-usage-monitor` Render service keeps its own R2 bucket
(`api-usage-monitor-backups`) and credentials, configured through Render's
Environment tab with `sync: false` placeholders in `render.yaml`. That
dashboard flow applies to a deliberate, owner-directed revival of the rollback
host only — never to production. A host rollback requires quiescing Oracle and
restoring the latest verified Garage lineage before transferring
scheduler/writer authority; never reverse DNS onto Render's stale database.
On the rollback host, `LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false` is the
sanctioned way to run without the Oracle heartbeat probe.

## Disaster recovery

For the specific incident where the live database file has been deleted or
replaced underneath the running writer (readiness reasons
`database_file_unlinked` / `database_file_missing` /
`database_file_replaced`), **stop — do not restart anything** — and follow
`docs/runbooks/sqlite-data-loss-incident.md`. A restart destroys the open
descriptor that may be the only remaining copy. The steps below are the
general replica-restore path for a database that is merely lost or corrupt.

`scripts/litestream-restore.sh` restores the latest replica to a scratch file — it
never overwrites the live `/data/prod.db` directly. Run it inside the app
container on the Oracle VM (the Garage creds and the `/data` disk are only
reachable there):

```bash
sudo docker exec oracle-app-1 bash scripts/litestream-restore.sh /data/prod.db.restored

# Verify:
sudo sqlite3 /data/prod.db.restored 'PRAGMA integrity_check;'
sudo sqlite3 /data/prod.db.restored 'SELECT count(*) FROM "UsageSnapshot";'

# Activate (keep a timestamped backup of the old file first):
sudo cp -a /data/prod.db /data/prod.db.bak-$(date +%Y%m%d-%H%M%S)
sudo cp /data/prod.db.restored /data/prod.db
sudo chown 1000:1000 /data/prod.db && sudo chmod 0600 /data/prod.db
# Then restart through the mount-gated systemd unit (never `docker restart`;
# the container's restart policy is deliberately `no`) so the running process
# and litestream reopen the swapped-in file:
sudo systemctl restart usage-monitor
```

Point-in-time restore (0.5.x): pass `-timestamp 2026-06-21T18:00:00Z` or
`-txid <hex>` — see the flags printed at the end of `litestream-restore.sh`'s output,
or `bin/litestream restore -h`.

If the disk is wiped entirely (new volume, container recreated), you don't
need to run this manually at all: `scripts/start-with-litestream.sh` already
calls `litestream restore -if-db-not-exists -if-replica-exists` before
`migrate-safe.mjs` on every boot, so a fresh empty disk recovers from Garage
automatically as long as `LITESTREAM_S3_*` is set.

### Restore verification

Restore is exercised continuously, not just at drills:

- Every production deploy hard-gates LTX freshness (≤ 3600s) plus an
  authenticated restore dry-run, and acceptance performs a full authenticated
  Garage restore with a complete SQLite integrity scan
  (`deploy/oracle/deploy-production.sh`).
- The fleet-sentry-monitor singleton runs an authenticated dry-run every 15
  minutes and a weekly full-integrity restore to
  `/data/.garage-backup-monitor-restore.db`
  (`deploy/oracle/README.md` "Backup monitoring").

Still run a **manual** drill quarterly and after any Litestream version bump —
a wrong `-config` path, a stale/incompatible LTX generation, or a
read-permission gap only surfaces on the exact command an operator would type
during an incident:

1. `sudo docker exec oracle-app-1 bash scripts/litestream-restore.sh /data/prod.db.restore-drill`
2. `sudo sqlite3 /data/prod.db.restore-drill 'PRAGMA integrity_check;'` — expect `ok`.
3. Compare `SELECT count(*) FROM "UsageSnapshot";` (or another frequently-written
   table) between the restored file and the live `/data/prod.db` — restored count
   should be close to (at or slightly behind) live, never ahead of it.
4. `sudo rm /data/prod.db.restore-drill` — do not leave the scratch file on the
   disk, and do not `cp` it over the live DB as part of a drill.
5. Record the outcome (date, litestream version, integrity result, count delta) as a
   `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md` note, matching this repo's
   existing `docs/rollouts/` convention.

## Monitoring

```bash
sudo docker exec oracle-app-1 /app/bin/litestream ltx -config /app/litestream.yml /data/prod.db | tail
cat /data/.litestream-replica-status.json
```

Or tail `sudo docker logs oracle-app-1` and watch for repeated `replica sync`
lines without errors. The strict readiness endpoint
(`/api/ready?strict=1` → `checks.backup`) and the fleet-sentry-monitor Sentry
cron check-in (`usage-monitor-garage-backup`) both alert on replica failure
independently.
