## Current (2026-08-16 GROK — ASC EULA + beta review)

Owner-authorized ASC writes.  Usage Client and Usage Local now have custom
EULAs and filled beta App Review contacts (Jay Wedgeworth, no demo
account).  Store versions were already `1.0.0`.  What's New is blocked on
these first / REJECTED versions.  Receipt:
`docs/rollouts/2026-08-16-asc-eula.md`.

## Current (2026-08-14 GROK — four Cloudflare provider rows)

Live Provider table had **zero** cloudflare rows.  Boot now seeds four builtin
accounts: Usage.Jays.Services, Socratic.Trade, Congress.Trade, Jay Old.
Usage.Jays.Services uses `CLOUDFLARE_JAY_*` first (not ST/CT/Old).  Fleet token
is the fallback.  Adapter routes `cloudflare-*`.  mustKeepFunded stays owner-owned.

## Prior (2026-08-13 GROK — hide LLM stay-funded + fourth CF account)

Branch `grok/pickup-um-cf-accounts`, worktree `~/apps/usage-grok-pickup`.  Pickup after Monet/Claude quota cap.

- LLM/AI providers no longer show "Must stay funded".  API still accepts a later re-enable.
- Fourth Cloudflare fleet slot **Jay (Old)** (`CLOUDFLARE_OLD_ACCOUNT_ID`, fleet token).  Usage.Jays.Services / ST / CT were already wired.
- Infisical UM prod now has `CLOUDFLARE_OLD_ACCOUNT_ID` (len 32).  No token minted.

Rollout: `docs/rollouts/2026-08-13-pickup-stay-funded-and-cf-accounts.md`.

## Prior (2026-08-13 MONET — CI and iOS ship never ran on bot-merged PRs)

Branch `monet/ci-ship-trigger-bot-merge`.  A PR merged by `github-actions[bot]`
lands on `main` and dispatches **zero** workflow runs — GitHub raises no workflow
events for actions taken with `GITHUB_TOKEN`, and `auto-merge-prs.yml` arms
auto-merge with exactly that token.  PR #1145 (bot-merged, touching `ios/`)
produced no `ios-ship` run; #1159 (human merge) produced the only one this repo
has ever had.

**Review round 2 (blocker fixed before landing).**  The required `verify` job
used `needs: [schedule-gate]` with `if: should_run == '1'`.  The decide step
always exits 0, but the JOB can fail, time out, or be cancelled — and a failed
`needs:` dependency marks dependents **skipped**, which GitHub reports as a
**satisfied** required check, so a gate outage could have let a PR merge with the
whole verify suite never run.  It now uses
`!cancelled() && (event != 'schedule' || should_run != '0')`, the pattern
Socratic.Trade adopted in its PR #370.  This repo's ship wrappers exec the
**runtime** `/Users/jay/apps/ios-fleet/ship-testflight.sh`, which already carries
the fixed `ensure-tf-ready`, so no in-repo port was needed here — only
Congress.Trade keeps its own fleet copy.

Fix in three layers: both auto-merge workflows now refuse to arm without an
elevated identity (`GH_PAT` / `SHEPHERD_TOKEN` — neither exists in any fleet
repo) and print the `gh pr merge <n> --squash --auto` command instead; `ci.yml`
gains an hourly `schedule:` backstop behind a fail-closed gate job that skips
when `main`'s HEAD already has a run; `ios-ship.yml` gains
`cron: '13,43 * * * *'` plus `scripts/ios-scheduled-ship-gate.sh`, which ships
on a scheduled tick only when `ios/` actually changed since that app's last
successful ship, per app.  Without that gate a cron would ship a TestFlight
build for every backend commit — the owner does not want TestFlight spammed.

**Owner action:** add a `GH_PAT` secret to re-activate auto-merge.  Rollout:
`docs/rollouts/2026-08-13-ci-ship-trigger-bot-merge.md`.

## Prior

## Current (2026-08-12 CLAUDE — PagerDuty alert correctness)

Branch `claude/pd-alert-correctness`: zero pushed telemetry now records `unverifiable` instead of manufacturing a 100%-of-bill discrepancy (PD #64/#70 Twilio); `stale_snapshot` CLEAR stamps the same watermark as ACTIVE so resolves stop deadlocking; provider deletion resolves outstanding PagerDuty incidents first (409 + `?force=true` override). Rollout: `docs/rollouts/2026-08-12-pagerduty-alert-correctness.md`.

## Prior

## Current (2026-08-10 GROK — default light theme)

Light is product default (web ThemeProvider + iOS AppSettings). Rollout: `docs/rollouts/2026-08-10-default-light-theme.md`.

## Prior

## Current (2026-08-10 GROK — ST OOM + fleet ops visibility)

Branch `grok/st-ops-fleet-visibility`: Operations full ST health + Coolify fleet; host ST 6g + backup keep-3. Rollout: `docs/rollouts/2026-08-10-st-oom-and-fleet-ops-visibility.md`.

## Prior

## Current (2026-08-04 GROK)

- iOS TestFlight agent ship: `bash scripts/ios-ship-testflight.sh` (fleet `/Users/jay/apps/ios-fleet/README.md`).

# Status

> **Historical snapshot — 2026-07-21.** This file describes the unmerged side
> branch `codex/mobile-first-ios-parity-20260721` (native iOS parity worktree),
> not the current state of `main`. It is retained as a dated record only. For
> current production state see `main` (deployed revision: `/api/health` on
> https://usage.jays.services) and `docs/EFFORT-LOG.md`.

Updated: 2026-07-21

## Current state

- Native mobile-first work is isolated on `codex/mobile-first-ios-parity-20260721` in
  `/Users/jay/apps/usage-monitor-mobile-first`.
- The app now targets iOS 26 and retains automatic Release signing for team `CC8UTF7ATG`.
- Existing Overview, Providers, Alerts, Projects, Settings, Widget, App Lock, offline cache, and
  background-refresh surfaces are preserved. Settings now adds session-backed native provider and
  subscription management without storing the dashboard password.
- `GET /api/budget-status` accepts either the dedicated read bearer or a verified dashboard session;
  mutations remain session-only.
- No Oracle, DNS, writer, scheduler, production data, provider, or secret mutation occurred.

## Native hardening and management

- Candidate read tokens are verified in a cookie-free disposable session, so an existing dashboard
  cookie cannot mask a bad replacement token.
- Dashboard logout deletes the local cookie even if the server is offline. Host switches clear the
  prior host's local session and token/host changes invalidate in-memory, disk, and widget money state.
- Offline budget files are versioned, identity-scoped, atomic, backup-excluded, first-unlock protected,
  size bounded, symlink rejecting, and stored with restrictive permissions.
- Native full access lists providers and tracked subscriptions, safely toggles eligible providers,
  edits or explicitly clears monthly budgets while preserving the rest of the plan, and pauses active
  subscriptions after confirmation. Successful mutations refresh the shared budget/widget state.
- Notification permission is requested only after explicit Settings opt-in. Alerts still schedule as
  **local** notifications from background refresh. Remote APNs is now a real sender: devices register
  at `POST /api/apns/device-tokens`, and budget/alert pages fan out over HTTP/2 when `APNS_*` is set.
  The checked-in entitlement stays `aps-environment=development` (App Store rewrites distribution).
  Silent `remote-notification` background mode is still omitted — these are visible alerts.

## Verification

- XcodeGen generation: passed.
- Generic iOS Simulator app/test-target `build-for-testing`: passed after the final security fixes.
- Release simulator compile: passed after fixing preview-only code that leaked into Release.
- Focused budget-route Vitest: 4/4 passed; scoped ESLint and TypeScript passed after the upstream rebase.
- `git diff --check`: passed.
- XCTest execution is blocked because this machine has no installed iOS Simulator runtime; test-target
  compilation is green.

## Remaining release stages

Open a PR, resolve hosted review/checks, merge, and verify the deployed server SHA separately.
The native binary still needs a real-device/App Store archive and TestFlight receipt before it is shipped.

## Current (2026-08-07 GROK)

- Backblaze B2 builtin provider (web + iOS Local storage inventory / catalog MTD estimate) on branch `grok/backblaze-usage-monitor`.
