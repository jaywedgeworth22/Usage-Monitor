# Ingest token scoping and `USAGE_INGEST_TOKEN` rotation (2026-09-24)

Board row `5ea89e8f03404cc5816b007f73e6fab0` (CLAUDE).  Owner-approved.

## Why

The live, unscoped `USAGE_INGEST_TOKEN` was printed into a local agent transcript on 2026-09-24.  It is a write-only ingest credential (production reads need `USAGE_READ_TOKEN`), so the risk is forged usage data.  The same value was also present in several local crash dumps and an Antigravity conversation store.  Goal: the old value is dead, every producer has its own `producerId:token` pair in `USAGE_INGEST_PRODUCER_TOKENS`, and `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`.

## How scoping works

`resolveUsageIngestCredential` (`src/lib/ingest-auth.ts`) matches the presented token against each `producerId:token` entry.  A match authorizes exactly that one producer:

- `POST /api/ingest/usage`: every event's `sourceApp` must equal the producer id.  For v2 batches `sourceApp` is the batch `producerId`, so a v2 producer's scope is its `producerId`.
- `POST /api/otlp/v1/metrics`: only a `claude-code` (or `system-metrics`) scope is accepted, and every mapped event must carry that `sourceApp`.  Claude Code OTLP needs no code change; it needs a `claude-code` scoped token.
- `POST /api/ingest/mac-heartbeat`: heartbeats persist as `sourceApp` `mac-host`.  This change makes the route refuse a token scoped to any other producer.

With `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true` the unscoped `USAGE_INGEST_TOKEN` is refused on all three routes.  The same producer id may appear more than once with different tokens.

## Code changes in this PR

- `scripts/subscription-quota-collector.mjs` posted four producers (`claude-code`, `openai-codex`, `grok-build`, `minimax-code`) with one token, which no single scoped token can authorize.  It now resolves one token per provider batch: `CLAUDE_CODE_INGEST_TOKEN`, `CODEX_INGEST_TOKEN`, `GROK_INGEST_TOKEN`, `MINIMAX_INGEST_TOKEN`, each falling back to `SUBSCRIPTION_QUOTA_INGEST_TOKEN`, then `USAGE_INGEST_TOKEN`.
- `scripts/ops/mac-server-watchdog.sh` reads `MAC_HEARTBEAT_INGEST_TOKEN` (environment, then `~/.secrets/global-api-keys`) before `USAGE_INGEST_TOKEN`.
- `POST /api/ingest/mac-heartbeat` rejects a token scoped to a producer other than `mac-host`.
- Tests: scoped `claude-code` OTLP acceptance (and unscoped/other-producer refusal under the flag), heartbeat route scoping, collector token precedence.

## Producer inventory (names only, no values)

Live producers are the `sourceApp` values the production database received in the 14 days before the change, plus known scheduled Mac jobs.

| Producer id | Consumer | Credential location | Before |
| --- | --- | --- | --- |
| `claude-code` | Claude Code OTLP metrics (all Mac seats) | `~/.claude/settings.json` `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Shared |
| `claude-code` | Subscription quota collector, Claude batch | `CLAUDE_CODE_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `openai-codex` | `com.jays.codex-usage-collector` and the quota collector's Codex batch | `CODEX_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `grok-build` | `com.jays.grok-usage-collector` and the quota collector's Grok batch | `GROK_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `github-copilot` | `com.jays.copilot-usage-collector` | `COPILOT_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `minimax-code` | Quota collector's MiniMax batch (and on-demand `minimax-usage-collector.mjs`) | `MINIMAX_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `deepseek-dsh` | On-demand `deepseek-usage-collector.mjs` | `DEEPSEEK_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `antigravity-cli` | `com.jays.antigravity-usage-collector` | `ANTIGRAVITY_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Already scoped |
| `antigravity-statusline` | `com.jays.antigravity-session-collector` | plist `EnvironmentVariables` | Scoped by board row `078333b0` |
| `mac-host` | `com.jays.mac-server-watchdog` heartbeat | `MAC_HEARTBEAT_INGEST_TOKEN` in `~/.secrets/global-api-keys` | Shared |
| `codecaps` | CodeCaps menu bar app (Mac) | macOS Keychain, entered in the app's settings | Shared (owner must paste) |
| `botfleet` | BotFleet harness on the Mac | `~/.botfleet/config.json` `usage.ingestToken` and BotFleet Infisical `USAGE_MONITOR_INGEST_TOKEN` | Shared |
| `congress-trade` | Congress.Trade on Coolify | Congress.Trade Infisical `USAGE_MONITOR_INGEST_TOKEN` | Shared |
| `socratic-trade` | Socratic.Trade on Coolify | Socratic.Trade Infisical `USAGE_INGEST_TOKEN` | Shared |

Not producers: `agent-bar` (the pre-rename CodeCaps app, silent since 2026-09-21), `owner-recorded-expense` (its own `OWNER_EXPENSE_TOKEN` route), `manual-billing-adjustment` and `subscription` (on-demand import and the internal materializer).  No GitHub Actions secret in any fleet repo carries an ingest token.  Codex Cloud setup only receives `SLACK_BOT_TOKEN` and `GH_TOKEN`.

- `scripts/fleet-usage-collector.mjs` (on-demand) also posts several producers per pass; it now resolves each batch's own `<PRODUCER>_INGEST_TOKEN` before `USAGE_INGEST_TOKEN`.

The on-demand `import-manual-subscription-events.mjs` posts only `manual-billing-adjustment`; once the flag is on, run it with a token scoped to that producer passed as `USAGE_INGEST_TOKEN` in the environment for that run.

## Rotation runbook

1. Generate one token per producer (`secrets.token_hex(32)`), append every `producerId:token` pair to `USAGE_INGEST_PRODUCER_TOKENS` in Infisical `usage-monitor` prod in one read-modify-write, and store each token as its own Infisical secret for recovery (`<PRODUCER>_INGEST_TOKEN`).
2. Restart the production container so `infisical run` re-reads the vault, then install each token in its consumer and prove a 2xx.
3. Rotate `USAGE_INGEST_TOKEN` in Infisical and in the Coolify application env (both copies exist; Infisical wins at runtime), reload, update the handoff file, and prove the old value returns 401.
4. Set `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`, reload, and prove every producer still succeeds and an unscoped request is refused.

Values are handled only inside short-lived local scripts that print key names, lengths, SHA-256 prefixes, and HTTP status codes.
