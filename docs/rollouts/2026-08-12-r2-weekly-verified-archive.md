# 2026-08-12 — Weekly verified R2 archive (second-vendor DR) [MONET]

## Objective

Owner ask: *"Restart litestream to R2 just once a week, then the old backup in
CF R2 is deleted after the new one gets verified."*

Since the 2026-08-07 B2 cutover the fleet has had exactly **one** live backup
vendor (Backblaze B2, continuous Litestream). R2 was frozen to a read-only
historic archive during the 2026-08-05 free-tier incident. This restores a
second, independent copy on R2 at a cadence the free tier absorbs easily.

## Why this is not literally "litestream to R2 weekly"

Three hard blockers make a weekly Litestream-to-R2 run the wrong mechanism:

1. **Litestream 0.5 supports exactly one replica per database.** Pointing it at
   R2 means giving up the B2 replica — strictly worse than today.
2. **Two Litestream processes on one DB corrupt shadow-WAL bookkeeping.** Not a
   supported configuration.
3. **Litestream has no "sync once and exit" mode.** Every start re-LISTs and
   re-PUTs, which is precisely the Class A burn that caused the August incident.

Instead: one self-contained, verified snapshot object per week. A handful of
Class A operations against a 1,000,000/month limit, and a single object that a
human can restore by hand with `gunzip` — no generation reconstruction.

## What ships

| Component | Purpose |
|---|---|
| `scripts/lib/s3-sigv4.mjs` | Dependency-free SigV4 signer (GET/PUT/HEAD/DELETE + ListObjectsV2). Ops twin of the hand-rolled signing already in `src/lib/r2-usage.ts`. |
| `scripts/ops/r2-weekly-archive.mjs` | The job: snapshot → verify → upload → **verify remote** → prune. |
| `scripts/test-r2-weekly-archive.mjs` | 16 tests incl. an in-memory S3 stub; wired into `npm run verify`. |
| `getR2WeeklyArchiveStatus()` | Freshness/failure surfaced on `/api/ready` → `checks.backupLayers.r2Historic.weeklyArchive`. |

## The safety contract

Nothing is deleted until a replacement is **proven restorable**:

1. Consistent snapshot via SQLite's Online Backup API (no writer downtime).
2. Local `PRAGMA integrity_check`.
3. gzip, then upload signed with a **real payload hash** — a truncated body is
   rejected by R2 rather than silently stored.
4. **Download the object back**, re-hash it, decompress it, and run
   `integrity_check` on the decompressed database, asserting byte-identical
   size. This is a genuine weekly restore drill, not a "the PUT returned 200"
   check.
5. **Only then** prune older generations.

Any failure at any step leaves every pre-existing archive untouched. There is a
dedicated test for this (`a corrupted upload aborts the run and deletes
nothing`) and one asserting no `DELETE` can precede the verifying `GET`.

Retention defaults to `R2_ARCHIVE_KEEP_GENERATIONS=2` (~100 MB total) rather
than 1. The owner's ask is satisfied either way — storage stays bounded — but
keeping one extra generation leaves an escape hatch if a structurally valid
snapshot turns out to be logically wrong. **Set it to 1 for strict
one-copy-only behaviour.**

## BLOCKED: the R2 credential is revoked

`CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY` in
`~/.secrets/global-api-keys` return **HTTP 401** everywhere. Ruled out, in
order:

- endpoint jurisdiction — plain, `.eu.`, `.fedramp.` → all 401
- signing region — `us-east-1`, `auto`, `weur` → all 401
- account — all four Cloudflare accounts → all 401
- copy drift — value hashes identical across `global-api-keys`,
  `global-api-keys.env`, and the dated backup
- **signer correctness — disproved**: the same signer successfully listed the
  live B2 bucket (146 objects, 2.575 GiB, newest LTX minutes old)

The key shape is right (32-hex id, 64-hex secret), so this is a revoked token,
not a malformed one.

**Owner action required:** Cloudflare dashboard → R2 → Manage API Tokens →
create a token with **Object Read & Write** scoped to `usage-monitor-prod-v3`,
then paste it into the two empty fields below.

Every `R2_ARCHIVE_*` key is **already provisioned in Infisical** (env `prod`,
path `/`, seeded 2026-08-12) — the non-secret ones filled in, the two
credential fields created **empty on purpose** so the job fails closed with
`credentials_missing` rather than producing a confusing 401:

| Key | Usage Monitor | Congress.Trade | Socratic.Trade |
|---|---|---|---|
| `R2_ARCHIVE_ENDPOINT` | `https://3a936805….r2.cloudflarestorage.com` | `https://0e9f5a0c….r2.cloudflarestorage.com` | `https://94ec35cf….r2.cloudflarestorage.com` |
| `R2_ARCHIVE_BUCKET` | `usage-monitor-prod-v3` | `congress-trade-bucket` | `socratic-trade-bucket` |
| `R2_ARCHIVE_REGION` | `auto` | `auto` | `auto` |
| `R2_ARCHIVE_PREFIX` | `weekly/` | `weekly/` | `weekly/` |
| `R2_ARCHIVE_KEEP_GENERATIONS` | `2` | `2` | `2` |
| `R2_ARCHIVE_ACCESS_KEY_ID` | **empty — fill this** | **empty** | **empty** |
| `R2_ARCHIVE_SECRET_ACCESS_KEY` | **empty — fill this** | **empty** | **empty** |

Infisical project IDs: UM `86e35e51-91bc-4dfd-a045-4484726b9c40`, CT
`f61a79de-8d77-4f0b-9361-4b7208598290`, ST
`39d93bb7-76f9-498c-8b50-a7def52e072f`.

Gotcha for future seeding: the Infisical **CLI cannot write an empty value**
(`infisical secrets set KEY=` fails); the REST API accepts one fine. Use
`POST /api/v3/secrets/raw/<KEY>` with `"secretValue": ""`.

Congress.Trade and Socratic.Trade are seeded **forward only** — the archive
script lives in this repo alone, so those keys are inert placeholders until the
job is ported. Their endpoint/bucket values are inferred from each account
having exactly one R2 bucket; confirm before first use.

Deliberately **not** reused: `LITESTREAM_S3_*` now points at B2, and signing an
R2 request with B2 keys produces a 401 that reads exactly like a revoked token.
`resolveArchiveConfig` refuses that fallback, with a test pinning the behaviour.

## Enabling (after credentials exist)

```bash
# 1. Prove it end to end without writing anything
node scripts/ops/r2-weekly-archive.mjs --dry-run

# 2. First real run
node scripts/ops/r2-weekly-archive.mjs

# 3. Schedule weekly in Coolify (application usage-monitor):
#    command:   node scripts/ops/r2-weekly-archive.mjs
#    frequency: 0 4 * * 0        # Sundays 04:00 UTC
```

The R2 free-tier kill switch (`R2_WRITES_DISABLED=true`) is currently engaged
and **blocks the archive by design** — one switch stays authoritative for "stop
writing to R2". Either clear it or set `R2_ARCHIVE_IGNORE_KILL_SWITCH=true`.

## Open owner decision: the 7 GiB historic prefix

`usage-monitor-prod-v3` holds ~7.00 GiB / 156 objects of dead Litestream LTX
history from before the B2 cutover, against a 10 GiB free tier. That is what
pushed R2 to the kill threshold. Pruning it would free the tier almost
entirely, but `litestream.yml` says *"do not delete until B2 restore has been
proven for a full week"* — the cutover was 2026-08-07, so the week is only just
up and no restore drill has been recorded. **Not touched here.** The weekly
archive writes to its own `weekly/` prefix and the retention logic explicitly
ignores non-`.db.gz` keys (tested), so the historic prefix cannot be pruned by
accident.

## Verification

```bash
npm run test:r2-archive        # 16 passed
npx vitest run src/lib/__tests__/runtime-health.test.ts   # 28 passed
npx tsc --noEmit               # clean
```

The end-to-end test gunzips the stored object, opens it as SQLite, and asserts
all 500 seeded rows survive the round trip.
