# Render SQLite readiness/restart-loop repair

## Summary

Diagnosed and repaired a production restart livelock on the paid Render Starter service. Scheduled retention no longer performs a full SQLite `VACUUM` unless an operator explicitly opts in, Render liveness no longer depends on the strict SQLite readiness probe, and concurrent readiness requests reuse one outstanding database probe instead of queueing uncancellable Prisma queries.

This note records locally verified implementation state. Merge, Render Blueprint synchronization, and live recovery verification remain pending.

## Why

Render reported the service as paid and `not_suspended`; the outage was not caused by account bandwidth, billing, or plan limits. Logs showed recurring Prisma `P1008` database timeouts followed by termination/restart of the sole instance. On every boot, the in-process scheduler immediately entered retention, pruned rows, checkpointed the WAL, and ran a full exclusive `VACUUM` against an approximately 129.7 MB SQLite database. The strict `/api/ready` health check timed out during that lock, so Render restarted the process before maintenance could finish; the next boot repeated the same cycle.

The repair separates liveness from readiness and keeps expensive whole-database compaction operator-controlled. `/api/ready` remains available for strict scheduler/database/backup diagnostics; it is not an appropriate automatic process-restart signal for a single-instance SQLite service.

## Files

- `.env.example`
- `DEPLOY.md`
- `render.yaml`
- `scripts/test-startup-config.mjs`
- `src/app/api/ready/route.ts`
- `src/app/api/ready/__tests__/route.test.ts`
- `src/lib/data-retention.ts`
- `src/lib/usage-retention.ts`
- `src/lib/__tests__/usage-retention.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-render-sqlite-readiness.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (branch-neutral live board)

## Verification

All Node commands used Node `v24.18.0` from `/opt/homebrew/opt/node@24/bin`.

- `npm ci` — passed; Prisma client generated; 512 packages installed; 0 vulnerabilities.
- `npm test -- src/lib/__tests__/usage-retention.test.ts src/app/api/ready/__tests__/route.test.ts` — passed, 2 files / 12 tests.
- `npm run test:startup-config` — passed.
- `npm run lint -- src/lib/data-retention.ts src/lib/usage-retention.ts src/lib/__tests__/usage-retention.test.ts` — passed.
- `npm run typecheck` — passed after correcting the helper's testable environment type.
- `npm run verify` — passed: ESLint; TypeScript; 73 Vitest files / 440 tests; safe-migration reproduction; SQLite backup checks; startup configuration checks; production build.
- `git diff --check` — passed.
- Independent hostile review — ACCEPT; no blocking findings.

Two accidental install attempts under the shell-default Node 26 were stopped at the engine guard before tests. The successful install and every verification command above used supported Node 24; this is additional evidence not to upgrade the repo to Node 26 now.

## Follow-ups

- Open a ready PR, enable auto-merge, and wait for required checks.
- Confirm the live Render service configuration actually synchronizes `healthCheckPath: /api/health`; repository YAML alone is not runtime proof.
- Verify sustained `/api/health` 200 responses, strict `/api/ready` recovery, stable instance uptime, and absence of the Prisma timeout/restart pattern.
- Verify an authenticated usage-ingest request returns 2xx before unblocking Socratic.Trade replay PR #1563.
- Schedule any future full `VACUUM` only in a deliberate maintenance window with `DATA_RETENTION_ENABLE_VACUUM=true`; the legacy disable flag remains an overriding kill switch.
