# 2026-08-31 — /api/health r2Weekly + replica-status probe cost trim

## Context & Objective

Two independent asks landed together: (1) `/api/health` exposed no backup status at
all, unlike Socratic.Trade and Congress.Trade's `checks.storage.r2Weekly`, so no
external monitor or peer-fleet parser could read Usage Monitor's weekly R2 archive
freshness off its public health path; (2) the host systemd timer
`usage-monitor-replica-status` (every 10 min) was driving ~720 Backblaze Class C
LIST calls/day for a probe that spent most of that budget on redundant work — an
in-container heartbeat attempt that always fails on this infra, and 5 LTX-level
listings per tick when 2 give the same freshness verdict.

## Changes Made

### 1. `checks.storage.r2Weekly` on `/api/health`

- Added `getPublicR2WeeklyHealth()` (`src/lib/runtime-health.ts`), a thin public-safe
  wrapper around the existing `getR2WeeklyArchiveStatus()` (already used by the
  session-gated operations card).  Shape: `{ok, key, ageSeconds, staleness, reason}`.
  `ok` requires the weekly archive job's own `ok:true` **and** `completedAt` inside
  the existing 8-day freshness window — both already enforced inside
  `getR2WeeklyArchiveStatus`, so this wrapper adds no new freshness logic, only a
  public-safe reshaping.  A missing or unreadable receipt collapses to a single
  `reason: "no_receipt"` (the internal `archive_status_unreadable` / never-run
  distinction is operator detail, not something an unauthenticated endpoint needs).
- Wired it into `GET /api/health` (`src/app/api/health/route.ts`) under
  `checks.storage.r2Weekly`.
- Tests: `src/lib/__tests__/runtime-health.test.ts` (no_receipt / unreadable / fresh /
  stale-by-age / stale-by-job-failure cases) and a new
  `src/app/api/health/__tests__/route.test.ts` exercising the route end-to-end.

This work was already complete and committed-in-progress on this branch from a
prior session before this one picked it up; it was reviewed here and found correct
as-is (see Decisions & Trade-offs).

### 2. `replica-status-probe.sh` cost trim (host systemd timer)

- `deploy/coolify/replica-status-probe.sh`: removed the in-container
  `docker exec … replica-status-heartbeat.sh --once` attempt entirely.  On Coolify a
  bare `docker exec` never carries the Infisical-injected `LITESTREAM_S3_*` env (the
  script's own header already documented this), so that attempt failed with
  `replica_credentials_missing` on every single tick and the host script always fell
  through to the env-file fallback anyway — it was pure overhead (one wasted
  `docker exec` + bash spawn per tick), never a real fallback candidate.  The probe now
  goes straight to the host env-file LTX fallback.
- Same file: trimmed the fallback's `litestream ltx -level N` loop from
  `(0, 1, 2, 3, 9)` to `(0, 9)` — level 0 proves continuous replication is alive,
  level 9 proves a snapshot exists; levels 1-3 are coarser compactions of the same
  continuous stream and never add a freshness signal level 0 doesn't already give.
  This is the change that actually moves the Backblaze Class C bill: 5 LIST calls/tick
  -> 2 LIST calls/tick.
- `deploy/coolify/usage-monitor-replica-status.timer`: cadence widened
  `OnUnitInactiveSec=10min` -> `OnUnitActiveSec=30min` (per explicit request), still
  comfortably inside the 3-hour `LITESTREAM_REPLICA_MAX_AGE_SECONDS` staleness budget.
  Combined with the level trim, the daily call volume for this probe drops from
  ~720/day (5 calls x 144 ticks/day) to ~96/day (2 calls x 48 ticks/day) — a ~7.5x cut.
- `deploy/coolify/usage-monitor-replica-status.service`: updated the stale
  "five 70-second listings" comment to match (now two); `TimeoutStartSec=480` is
  untouched (already generous headroom for 2 x 70s + overhead).
- `scripts/test-replica-status-probe.sh`: replaced the assertions that pinned the old
  two-path fallback design (heartbeat exit-code gate, mtime-refresh preference, "must
  still reach --env-file fallback" wording) with assertions for the new single-path
  design: no `run_in_container_heartbeat` reference, no live `docker exec …
  replica-status-heartbeat.sh` invocation, the level loop is exactly `(0, 9)` (and
  explicitly not the old five-level tuple), and the timer carries
  `OnUnitActiveSec=30min` (not the old `OnUnitInactiveSec=10min`).  All existing
  secret-safety assertions (`--env-file`, no `-e KEY=VALUE` on `docker exec` argv,
  no plaintext `LITESTREAM_S3_*` in argv) are unchanged.
- `docs/runbooks/replica-status-probe.md`: updated the architecture table, "Host
  oneshot order" section, "What it lists" table, the `replica_credentials_missing`
  reason-table row, and the pitfalls list to describe the new single-path,
  levels-{0,9} design instead of the retired two-path one.  `deploy/oracle/**` (legacy,
  not live production per its own README) was left untouched — out of scope.

Files touched:
- `src/lib/runtime-health.ts`
- `src/app/api/health/route.ts`
- `src/lib/__tests__/runtime-health.test.ts`
- `src/app/api/health/__tests__/route.test.ts` (new)
- `deploy/coolify/replica-status-probe.sh`
- `deploy/coolify/usage-monitor-replica-status.timer`
- `deploy/coolify/usage-monitor-replica-status.service`
- `scripts/test-replica-status-probe.sh`
- `docs/runbooks/replica-status-probe.md`

## Decisions & Trade-offs

- **Did not touch the in-container looping heartbeat's own level set**
  (`scripts/replica-status-heartbeat.sh`, `CONTINUOUS_LEVELS=(0 1 2 3)` +
  `SNAPSHOT_LEVEL=9`).  That loop runs continuously inside the app container (started
  by `start-with-litestream.sh`, which *does* inherit the Infisical-injected env) and
  is a separate cost surface from the host timer this task scoped in on.  The task's
  own math (~720 calls/day = 5 calls x 144 ticks/day) accounts for the host timer's
  fallback alone, so widening scope to the in-container loop was not part of the ask
  and risks a different, unrequested behavior change.
- **Removed the in-container heartbeat attempt outright rather than adding a
  skip-flag.**  Coolify's env-injection-into-process-tree-only architecture is
  structural, not a transient condition, so there is no future scenario on this infra
  where a bare `docker exec` would succeed.  A flag to re-enable it would be dead
  configuration surface for a path that can never work here; if the infra
  ever changes, this is a one-line revert away in git history.
- **Left `deploy/oracle/**` untouched.**  Its own README already states "LEGACY — not
  live production"; changing it would be scope creep on dead infrastructure.
- **Left `TimeoutStartSec=480` in the `.service` file unchanged.**  Two 70s-timeout
  listings plus `docker top`/PID-environ overhead comfortably clears well under 480s;
  tightening it has no cost benefit (it only bounds worst-case duration, not call
  count) and reduces the safety margin for no reason.
- **Item 1 (r2Weekly health block) was found already complete on this branch** from a
  killed prior session's uncommitted work.  It was reviewed line-by-line against
  `getR2WeeklyArchiveStatus`'s actual freshness/reason semantics and against how
  Socratic.Trade and Congress.Trade shape their own `checks.storage.r2Weekly`
  (`{ok, ageSeconds, key, reason}` — no `staleness` field in either).  The extra
  `staleness` field here is additive, not a shape mismatch: this repo's own
  `fleet-backup-status.ts` peer parser (which reads *other* apps' `r2Weekly`) only
  ever consumes `ok` / `ageSeconds` / `reason`, so nothing downstream depends on the
  field sets matching exactly.  No code changes were needed for item 1 beyond
  verification.

## Verification State

Ran from `/Users/jay/apps/usage-claude-backup-probe` on Node 24.20.0
(`/opt/homebrew/opt/node@24/bin` — the repo pins `"node": ">=24.14.0 <25"` in
`package.json`, and the Mac's default `node` is v26, which risks native-module ABI
mismatches):

```bash
npm ci
npm run lint            # 0 errors, 12 pre-existing warnings (unrelated files)
npm run typecheck       # clean
npm test                # 2338 passed | 1 skipped (200 files)
npm run test:receipt-inbox-worker   # 8 passed
npm run test:migrate-safe           # all 5 scenarios PASSED
npm run test:sqlite-backup          # passed
npm run test:r2-archive             # 18 passed, 0 failed
npm run test:startup-config         # passed
npm run test:oracle-deploy          # passed
npm run test:apple-projects         # native iOS/Safari builds all succeeded (see note)
npm run test:antigravity-collector  # passed
npm run test:session-token-collectors  # passed
npm run test:cf-token-map           # passed
npm run test:replica-status-probe   # passed (updated assertions, see above)
npm run build                       # next build succeeded (Turbopack tracing
                                     # warnings are pre-existing, unrelated files)
```

Note on `test:apple-projects`: this step runs real `xcodebuild` locally when
`xcodebuild` is present (this repo's `AGENTS.md` "iOS agent build loop" explicitly
pre-approves that, unlike some sibling apps).  The first attempt showed
`BUILD FAILED` with a build-database disk I/O error — traced to two concurrent
`bash scripts/verify-apple-projects.sh` invocations racing on the same shared
`$RUNNER_TEMP/usage-monitor-apple-derived` directory (self-inflicted by running it
twice in parallel while investigating a timeout, not a real defect).  A single clean
re-run passed end-to-end (app debug + release, `UsageMonitorKit` package, both Safari
extension targets).  No iOS/Swift files were touched by this change.

`npm run verify`'s full chain was exercised piecewise above rather than as one
invocation (its final composed command is exactly the same steps in the same order).

## Next Steps & Blockers

- After merge, per fleet rules: SSH to `root@100.69.77.26`, back up then sync
  `/usr/local/sbin/usage-monitor-replica-status` from the merged `main`, `bash -n`
  it, sync the `.timer`/`.service` units, `systemctl daemon-reload` (unit files
  changed), run the probe once manually to prove a clean tick (2 LIST calls), and
  confirm the journal verdict line.  See the receipts in the closing chat message for
  the actual host commands run and their output.
- No further code changes anticipated for this lane.  The in-container heartbeat's own
  cost profile (continuous, 5 levels, real credentials) was explicitly left alone —
  flag if the owner wants that trimmed too in a follow-up.
