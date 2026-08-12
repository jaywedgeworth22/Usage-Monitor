# 2026-08-12 — Handoff to a local agent: finish Antigravity collector + check R2 kill-switch

Written by a cloud/remote session that cannot reach `agy`, Infisical, the
Hetzner host, or Xcode. Everything below needs a session running on the
Mac (local Claude Code, or the owner directly) to finish. Branch:
`claude/antigravity-telemetry-integration-k6tpjf`, PR **#1100** (draft):
https://github.com/jaywedgeworth22/Usage-Monitor/pull/1100

Two unrelated things are bundled on this branch — the Antigravity collector
(the actual task) and a small iOS wording fix for a backup-status card the
owner spotted while reviewing (already committed, just needs the checklist
in Part 2 to close the loop on the underlying flag). Don't split them
unless asked; just track them separately below.

---

## Part 1 — Antigravity quota collector (the main task)

Code is done (`scripts/antigravity-usage-collector.mjs`,
`scripts/com.jays.antigravity-usage-collector.plist.example`, rollout doc
at `docs/rollouts/2026-08-11-antigravity-usage-collector.md`). What's left
needs real `agy` + Infisical + the production host, none of which exist in
the cloud sandbox that wrote this.

1. **Pull the branch:**
   ```bash
   cd /path/to/Usage-Monitor
   git fetch origin claude/antigravity-telemetry-integration-k6tpjf
   git checkout claude/antigravity-telemetry-integration-k6tpjf
   ```

2. **Confirm `agy` is authenticated:**
   ```bash
   agy -p "/usage" --output-format json
   ```
   Should return `"status": "SUCCESS"`. If not, `agy` needs an interactive
   login first (headless mode uses cached credentials only).

3. **Dry-run the collector, no Infisical needed yet:**
   ```bash
   node scripts/antigravity-usage-collector.mjs --dry-run --debug
   ```
   Two outcomes:
   - **It parses cleanly** and the printed events look right (real model
     names, sane `credits`/`limit` numbers) → skip to step 4.
   - **It fails** with "did not start with a recognizable header row" → it
     dumped the raw `response` lines in the error. Open
     `scripts/antigravity-usage-collector.mjs`, find `COLUMN_ALIASES` near
     the top, and add whatever the real header words are (lowercased,
     letters only — the matcher strips everything else) to the right
     field's alias list. Re-run until it parses. This is the one thing
     that could not be verified without real `agy` output — see that
     file's header comment and
     `docs/rollouts/2026-08-11-antigravity-usage-collector.md` for the full
     "known gap" writeup.

4. **Add the Infisical secret.** Project `usage-monitor`
   (`86e35e51-91bc-4dfd-a045-4484726b9c40`), env `prod`, key
   `USAGE_INGEST_PRODUCER_TOKENS`. First check whether that key already has
   other `producerId:token` pairs (comma-separated) — if so, append rather
   than overwrite:
   ```
   antigravity-cli:2e817df198390f9d6ca8579b4b4000c6993c2b55b10e9f5582f941e6023c5a20
   ```
   (Generated in the cloud sandbox with `secrets.token_hex(32)` — fine to
   use as-is, or regenerate your own; either way it just needs to match
   what the collector sends.)

5. **Restart the usage-monitor app** (Coolify restart is enough, no
   redeploy needed) so `scripts/start-with-infisical.sh` re-injects the
   updated `USAGE_INGEST_PRODUCER_TOKENS` into the running process — it's
   read once at startup, not hot-reloaded.

6. **Send for real and verify:**
   ```bash
   infisical run --projectId 86e35e51-91bc-4dfd-a045-4484726b9c40 --env prod -- \
     node scripts/antigravity-usage-collector.mjs
   ```
   Check the printed ack (`persisted` should be > 0, `rejected` should be
   0), then confirm in the dashboard or `GET /api/usage-events` that a
   `provider: "google-antigravity"` event landed.

7. **Install the launchd job:**
   ```bash
   cp scripts/com.jays.antigravity-usage-collector.plist.example \
     ~/Library/LaunchAgents/com.jays.antigravity-usage-collector.plist
   ```
   Edit the 4 `/ABSOLUTE/PATH/TO/...` placeholders (`which node`,
   `which infisical`, this repo's path, `$HOME`), then:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jays.antigravity-usage-collector.plist
   ```
   Check `~/Library/Logs/antigravity-usage-collector.log` after the next
   4h tick.

8. **Mark PR #1100 ready for review and land it** once 3 and 6 are
   confirmed working (repo norm is commit → PR → merge without waiting to
   be asked, per `AGENTS.md` "Always commit + open PR + land").

---

## Part 2 — R2 free-tier kill-switch: stale flag check

Separate from the task above. While reviewing, the owner noticed the iOS
"R2 Historic" backup-status row read **"weekly freeze · writes paused"**
next to a green OK badge and asked if that's really fine.

**Already fixed and pushed** (commit `b6354c8` on this branch): the iOS
`r2Detail()` in `ServerStatusStore.swift` was appending "writes paused"
whenever the free-tier kill-switch flag was set, *regardless of role* —
but that flag is only meaningful while R2 is the live litestream target
(role `"active"`). Once B2 became primary and R2 moved to `"historic"`
(frozen, no longer written to, by design — see
`docs/rollouts/2026-08-06-backup-steady-state-policy.md`), the flag is
inert, and showing "writes paused" there was just confusing, not
inaccurate about anything real. Gated it on `role == "active"`, added a
regression test (`testR2HistoricDetailIgnoresStaleKillSwitchFlag` in
`SettingsFeatureTests.swift`). **Could not run `xcodebuild`/`swift test`
from the cloud sandbox — please build and run the iOS test suite once to
confirm it compiles and passes.**

What's still worth checking, because the wording bug only fired because
the underlying flag really is engaged in production right now:

1. SSH to the Hetzner host (`root@167.233.254.55`, `~/.ssh/hetzner` per
   `AGENTS.md`) and check:
   ```bash
   ls -la /data/r2-disabled-70pct.flag  # present?
   ```
   and check the Coolify env for `LITESTREAM_EMERGENCY_DISABLE` /
   `R2_WRITES_DISABLED`.
2. This traces back to `docs/rollouts/2026-08-04-r2-free-tier-prune-and-killswitch.md`,
   which called `LITESTREAM_EMERGENCY_DISABLE=true` a **temporary**
   measure "until the next deploy is live and storage is confirmed under
   70% after re-seed." That was over a week ago — worth confirming it
   wasn't just left on.
3. There IS an auto-resume path (`src/lib/r2-usage.ts`, `clearR2AutoDisable()`
   called when live storage % drops under `R2_RESUME_STORAGE_PCT`) — check
   whether that maintenance cycle has actually been running, or whether the
   flag is stuck because storage genuinely is still ≥70% (a real, separate
   cost concern worth knowing about even though it doesn't affect backup
   health anymore).
4. **This is not urgent** — since R2 is already `"historic"` (B2 is the
   real live backup target, checked with a real 3h freshness threshold,
   currently healthy per the "B2 Backup / replica 3m ago" row), the flag
   being stuck engaged has zero effect on actual backup health today. It's
   just worth clearing for hygiene if storage is comfortably under
   threshold, since a stale emergency flag from a resolved incident is the
   kind of thing that causes confusion later.
