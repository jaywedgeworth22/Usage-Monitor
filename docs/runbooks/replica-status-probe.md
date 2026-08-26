# Replica status probe (Coolify / Hetzner)

Operator runbook for the Litestream LTX side-channel that feeds
`/api/ready` `checks.backup`.  Architecture and B2 setup stay in
`docs/litestream.md`.  This page covers **how the probe decides**,
**why Coolify needs a host fallback**, and **how to read the reasons**.

Verified against `scripts/replica-status-heartbeat.sh`,
`deploy/coolify/replica-status-probe.sh`, `src/lib/runtime-health.ts`
`getBackupRuntimeStatus`, and `src/app/api/ready/route.ts` as of
#1354 / #1355 (`cfd532b`).

## Intent

Prove the off-site replica is advancing without making product readiness
depend on B2 listing.  The money-truth is live SQLite on `/data`.
Backup health is **observability only**: it never flips overall
`/api/ready` `ok`, and `?strict=1` uses that same `ok`
(database + databaseFile + scheduler + startup).

The probe writes `/data/.litestream-replica-status.json` (override with
`LITESTREAM_REPLICA_STATUS_PATH`).  JSON contract:

```json
{"ok": true, "checkedAt": "2026-08-25T15:00:00Z", "ltxAgeSeconds": 420, "reason": null}
```

- `checkedAt` drives staleness in Next.js (`LITESTREAM_REPLICA_MAX_AGE_SECONDS`, default 10800).
- `ltxAgeSeconds` is operator detail.  A frozen LTX age with a fresh `checkedAt` still passes the file-age gate.
- The heartbeat **omits** `ageSeconds` on purpose so a frozen file cannot pass forever.

## Architecture

Two writers, one status file:

| Path | Who | Credentials | When |
|---|---|---|---|
| Looping heartbeat | `scripts/replica-status-heartbeat.sh` (child of `start-with-litestream.sh`) | Inherits Infisical from the process tree | Every `LITESTREAM_REPLICA_HEARTBEAT_INTERVAL_SECONDS` (default 600) |
| Host oneshot | `deploy/coolify/replica-status-probe.sh` as `/usr/local/sbin/usage-monitor-replica-status` | See fallback below | 10-minute systemd timer |

Coolify injects Infisical into the **running process tree only**.
`docker exec` does not see those vars, so a bare `litestream ltx` inside
`docker exec` fails with "bucket required" / `replica_credentials_missing`.

### Host oneshot order (#1355)

1. `docker exec … replica-status-heartbeat.sh --once`.
2. Trust that write **only** when the command exits 0 **and** the status
   file `checkedAt` refreshed **and** `reason` is not
   `replica_credentials_missing`.
3. Otherwise run the host fallback: read the litestream `replicate` PID
   environ via `docker top` + `/proc/<pid>/environ`, write a mode-0600
   env file, `docker exec --env-file`, then delete the file.

Genuine exit-0 `--once` verdicts that **do** skip the fallback:
healthy continuous, `snapshot_only`, `ltx_age_exceeds_budget`,
intentional R2 pause (`r2_free_tier_disabled`).

Do **not** treat a cred-less `--once` write as a finished verdict.
#1354's "mtime refreshed ⇒ skip host" path poisoned a good looping
heartbeat with `replica_credentials_missing` and skipped `--env-file`.

### Secret constraint (#1354)

Never pass `LITESTREAM_S3_*` (or `AWS_*` replica keys) as
`docker exec -e KEY=VALUE`.  systemd journals capture argv.
Host fallback uses `--env-file` only.

## What it lists

Both heartbeat and host fallback call:

```text
litestream ltx -json -config /app/litestream.yml -level N /data/prod.db
```

| Level | Role | Pick rule |
|---|---|---|
| 0–3 | Continuous LTX | Newest timestamp among successful non-empty lists |
| 9 | Snapshot | Used only when 0–3 are empty; `reason=snapshot_only` |

Timeouts are 60s (heartbeat) / 70s (host).  TLS / ListObjectsV2 hangs
classify as `list_timeout`, not `no_parseable_ltx`.

## Operator reasons

Written on the status file and passed through `checks.backup.reason`
when `replicaOk` is false (except file-age, which becomes
`replica_status_stale`).

| Reason | Meaning | Typical next step |
|---|---|---|
| `null` | Continuous LTX tip within budget | None |
| `snapshot_only` | Only level 9 has a tip; still `ok=true` if age ≤ budget | Confirm L0–L3 are not wedged; not an outage by itself |
| `ltx_age_exceeds_budget` | Newest tip older than 10800s | Check `litestream replicate` logs / B2 writes |
| `list_timeout` | ListObjectsV2 / TLS / deadline | B2 or network; retry; do not treat as missing creds |
| `list_error` | Non-timeout list failure | Logs + endpoint / bucket name |
| `empty_ltx` | All listed levels returned `[]` | Fresh replica or wrong prefix |
| `no_parseable_ltx` | No usable timestamp and no more specific class | Inspect raw `ltx -json` |
| `replica_credentials_missing` | `LITESTREAM_S3_*` incomplete **in that process** | Expected for `docker exec --once` on Coolify; host `--env-file` should still run |
| `litestream_not_running` | Host fallback found no `litestream replicate` PID | Container / entrypoint |
| `litestream_binary_missing` | `/app/bin/litestream` not executable | Image build / `fetch-litestream.sh` |
| `r2_free_tier_disabled` | R2 endpoint + kill flag / `R2_WRITES_DISABLED` | Intentional pause; ignored on B2 |
| `invalid_ltx_timestamp` | JSON timestamp would not parse | Litestream version / listing format |
| `replica_status_missing` | Next.js: status path set, file absent | Timer not installed or volume mismatch |
| `replica_status_stale` | Next.js: `checkedAt` older than budget | Probe not refreshing |
| `replica_status_unreadable` | Next.js: read/parse failed, or host could not read PID environ | Permissions / JSON |
| `env_active_unverified` | Next.js: no `LITESTREAM_REPLICA_STATUS_PATH` | Set the path; `envOnly=true` |

## Pitfalls

- **`docker exec --once` success is not "creds worked".**  Exit 1 +
  `replica_credentials_missing` is the Coolify-normal miss.  Host
  fallback must still run.
- **Host script exit 0 is not "replica healthy".**  After a verdict is
  written, the oneshot exits 0 so systemd does not disable the timer.
  Read the JSON `ok` / `reason`.
- **Do not `docker exec -e LITESTREAM_S3_SECRET_ACCESS_KEY=…`.**  Journal leak.
- **`/api/ready` `ok` staying true is not backup-healthy.**  Watch
  `checks.backup.replicaOk` and Settings / iOS `backupLayers`.
- **Do not require `reason=null`.**  `snapshot_only` is a healthy
  continuous-empty / snapshot-present state.
- **UUID container + volume names.**  Prefix comes from
  `USAGE_MONITOR_COOLIFY_UUID` / fleet-ops, not `usage-monitor-app-1`.
- **#1353 leftover.**  Do not rematch the pre-`--env-file` argv-leak PR.

## Install / verify (Coolify host)

sudo install -o root -g root -m 0755 deploy/coolify/replica-status-probe.sh \
  /usr/local/sbin/usage-monitor-replica-status
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.service \
  /etc/systemd/system/usage-monitor-replica-status.service
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.timer \
  /etc/systemd/system/usage-monitor-replica-status.timer
sudo systemctl daemon-reload
sudo systemctl enable --now usage-monitor-replica-status.timer
sudo /usr/local/sbin/usage-monitor-replica-status
# journal: prefer "in-container heartbeat verdict" or "host env-file LTX fallback"
# never a leftover -e KEY=value in TimeoutExpired.cmd

curl -fsS https://usage.jays.services/api/ready | jq '{ok, backup: .checks.backup}'
```

Offline:

```bash
bash scripts/test-replica-status-probe.sh
bash scripts/replica-status-heartbeat.sh --self-test
```
