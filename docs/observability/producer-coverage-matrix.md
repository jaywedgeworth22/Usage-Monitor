# Producer coverage matrix — UM v2 ingest (2026-09-09)

Authoritative map of every known producer of `/api/ingest/usage` (and `/api/otlp/v1/metrics`) data, the v2 fields they send, the fields UM accepts, and any gap.  When this list drifts from reality, fix the list, not the contract: the v2 wire is owned by `@jaywedgeworth22/congress-trading-shared` and changes there require a cross-app PR.

## How the wire works

- v2 batch envelope = `{ schemaVersion: 2, producerId, producerInstanceId?, events: UsageTelemetryV2Event[] }` parsed by `src/lib/usage-telemetry.ts` against `UsageTelemetryV2BatchSchema` and `UsageTelemetryV2EventSchema` from `@jaywedgeworth22/congress-trading-shared`.  `sourceVersion` and `environment` are NOT batch-level fields in the strict v2 schema; `environment` lives on each event.
- Auth: `Authorization: Bearer ${USAGE_INGEST_TOKEN}` (or per-producer `USAGE_INGEST_PRODUCER_TOKENS` mapping when `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`).
- Idempotency: `eventId` is the producer's durable key; UM re-derives the same length-prefixed SHA-256 from the shared contract when absent.
- Persisted result semantics (narrower than request acceptance): `attempted` = submitted events, `persisted` = newly inserted rows, `skippedPrunedDuplicates` = blocked by retention tombstones.  Never derive `persisted` from `activeEvents.length`.
- Reserved `metadata` keys (producer spoof-proof): the four `_derivedCost*` keys, the `tokenType` split, the `coverage.*` echoes, the `project` mirror, and the per-source anchors.  Producers can add their own keys; see `src/lib/usage-telemetry.ts`.

## OTLP path (parallel to v2)

`POST /api/otlp/v1/metrics` accepts `Content-Type: application/json` (primary) or `application/x-protobuf`.  Does **not** accept gRPC (Claude Code's default `OTEL_EXPORTER_OTLP_PROTOCOL` value) — a gRPC-configured client gets `415` telling it to switch to `http/json` or `http/protobuf`.  Same bearer token as v2 ingest.  Both routes are excluded from the dashboard-session middleware (`src/middleware.ts`'s `api/otlp(?:/|$)` exclusion).

`POST /api/otlp/v1/logs` is a 200 accept-and-drop stub: errors and health stay in Sentry per the owner goal split; only metrics land here.

## Producer matrix (v2 ingest)

Producers listed are the ones observed sending at the time of writing (2026-09-09).  Each row: producerId, repo + worktree, transport, what they send, what they don't, and any caveat.

| Producer | Repo | Transport | `metricType` | Provider values | Service values | `billingMode` | `confidence` | `tokenType` split | `producerKeyRef` | `coverage` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code` (OTLP) | UM `/api/otlp/v1/metrics` | OTLP JSON/protobuf | usage, cost | anthropic | claude-code | n/a (from metric) | actual | input/output/cacheRead/cacheCreation | n/a | n/a | Mapped from `claude_code.token.usage` + `claude_code.cost.usage` by `src/lib/otlp/claude-code-mapper.ts`; idempotency key = hash(metric + attrs + window + value) |
| `claude-code` (local) | UM `scripts/claude-usage-collector.mjs` | v2 batch | usage, cost | anthropic | claude-code | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Reads `~/.claude/projects/*/*.jsonl`; emits four token events + an optional `cost.usage` event per turn |
| `openai-codex` | UM `scripts/codex-usage-collector.mjs` | v2 batch | usage, cost | openai | codex-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Parses `~/.codex/sessions/**/*.jsonl` `event_msg/token_count` `last_token_usage`; skips total-stagnant replays (openai/codex#14489, ccusage#876) |
| `grok-build` | UM `scripts/grok-usage-collector.mjs` | v2 batch | usage, cost | xai | grok-build | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | `~/.grok/sessions/**/updates.jsonl` `sessionUpdate=turn_completed` + `usage.modelUsage`; costUsd is `costUsdTicks / 1e10` |
| `github-copilot` | UM `scripts/copilot-usage-collector.mjs` | v2 batch | usage, cost | github | copilot-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | `~/.copilot/session-state/*/events.jsonl` `session.shutdown` `data.modelMetrics[].usage`; totals are cumulative across resume/shutdown, emit delta; `splitInclusiveCache` only subtracts `cacheRead` to keep cache writes priced (tokenuse, ccusage#1174) |
| `antigravity-cli` | UM `scripts/antigravity-usage-collector.mjs` + `scripts/antigravity-session-collector.mjs` | v2 batch | usage, cost | google | antigravity-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | `~/.antigravity/...` sessions |
| `deepseek-dsh` | UM `scripts/` (DSH harness) | v2 batch | usage, cost | deepseek | deepseek-dsh | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Local collector for DeepSeek Harness |
| `cursor-agent` | UM `scripts/` (Cursor) | v2 batch | usage, cost | cursor | cursor-agent | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Local collector for Cursor |
| `botfleet` | BotFleet `server/telemetry.ts` (`claude/sentry-usage-telemetry`) | v2 batch | usage, cost, limit | anthropic/openai/xai/google-ai/deepseek/moonshot/cursor/minimax/box/openai-compat | claude-code/codex-cli/grok-build/gemini-cli/deepseek-dsh/moonshot-kimi/cursor-agent/minimax-cli/box-api/openai-compat/... | actual | actual | input/cacheRead/output (split into 3 events) | model | `{ scope: "conversation", mode: "aggregate", relationship: "self", reportThrough: "botfleet" }` | eventId = `bf:<provider>:<botId>:<ts>:<uuid8>:<suffix>`; metadata carries roomId, roomName, model, tokenType |
| `socratic-trade` | Socratic.Trade `src/lib/usage-monitor-push.ts` | v2 batch | usage | tradier, finnhub, polygon, alphavantage, tiingo, twelvedata, sec, fmp, ... (per call-volume row) | `<provider>`-call-volume | actual | actual | n/a | n/a | n/a | events are call-volume rollups, not token events; `requests`+`successes`+`failures`; `label` echoes the source window id; `keySource`+`userId` ride metadata |
| `congress-trade` | Congress.Trade `app/src/shared/thirdPartyTelemetry.ts` | v2 batch | usage, cost, limit | mapped via `remapOpenRouterTelemetry` (openrouter → upstream provider) + raw providers (tradier, ...) | per descriptor | actual | actual | n/a (n/a for the wired sources) | n/a | n/a | Uses `createUsageTelemetryClient` from the shared package; routes through the same `/api/ingest/usage` |

## Producer matrix (poll adapters — non-v2 path)

UM poll adapters do **not** go through `/api/ingest/usage`; they write `UsageSnapshot` rows directly.  The two ingest paths are kept separate by design (per `AGENTS.md` "Push-primary providers"): the v2 ingest is the only event-stream; poll snapshots are point-in-time balance/total reads.

| Provider | Adapter | Poll cadence | Writes | Notes |
| --- | --- | --- | --- | --- |
| `anthropic` (org) | `src/lib/adapters/anthropic.ts` | every POLL_INTERVAL_MS (15 min) | `UsageSnapshot` (balance, totalCost, totalRequests) | `orgId`-keyed, pollable |
| `voyage` | blind (push only) | n/a | n/a (events only) | `ExternalUsageEvent` from the v2 ingest |
| `robinhood` | blind (push only) | n/a | n/a | `ExternalUsageEvent` from the v2 ingest |
| `tiingo`, `fmp`, `alphavantage`, `finnhub`, `polygon`, `tradier`, `twelvedata`, `sec`, `massive`, ... | `src/lib/adapters/*.ts` | 15 min | `UsageSnapshot` | Cost-coverage caveat tracked in `costCoverageCaveat`; keySource attribution via `key-attribution` |

## Field-level coverage (v2)

Fields the schema makes optional, and which producers actually send them.

| Field | Schema | Producers sending it | UM treatment |
| --- | --- | --- | --- |
| `eventId` | optional (re-derived if absent) | botfleet, socratic-trade, congress-trade, claude-code, all local collectors | Persisted; if absent, derived via shared `deriveUsageTelemetryIdempotencyKey` |
| `environment` | optional, defaults to producer's `env` | all v2 producers | Persisted; falls back to `process.env.SENTRY_ENVIRONMENT ?? "production"` |
| `provider` | required | all | Persisted; `Provider` row case-insensitive match in `budget-status.ts` (JS, not Prisma `mode: insensitive` — SQLite) |
| `service` | required | all | Persisted |
| `project` | optional | botfleet, socratic-trade, congress-trade | Resolved at ingest via `src/lib/project-resolver.ts` (case-insensitive); unknown names ride metadata + can be back-filled |
| `producerKeyRef` | optional | botfleet (model), all local collectors (model) | Persisted as `keyRef`; used by `/api/key-attribution` |
| `providerConnectionRef`, `billingAccountRef` | optional | congress-trade, socratic-trade (via `keySource`, `userId`) | Persisted |
| `coverage` | optional | botfleet | Persisted as `coverage` JSON; not in idempotency basis |
| `billingMode` | optional | all (actual or estimated) | Persisted |
| `metricType` | required | all (usage, cost, subscription, quota) | Persisted; **`quota_sync` and `credit_balance` are monitor-only** — the shared schema does not advertise them as producer-supplied.  A producer emitting them will pass Zod parse but the row will land in monitor-owned code paths only. |
| `quantity` | optional | local collectors, claude-code OTLP | Persisted |
| `unit` | optional | all | Persisted; defaults to `event` |
| `costUsd` | optional | all (botfleet: actual, local: estimated) | Persisted; cash math is recorded-wins, derived is metadata-only |
| `requests` | optional | socratic-trade, congress-trade | Persisted |
| `credits`, `limit`, `limitWindow` | optional | some producers | Persisted |
| `tier` | optional | some | Persisted |
| `confidence` | optional | all (actual or estimated) | Persisted |
| `windowStart`, `windowEnd` | optional | quota/budget producers | Persisted |
| `occurredAt` | required | all | Persisted; defaults to producer's `windowEnd` |
| `providerRequestId` | optional | some | Persisted; used by `/api/external-usage-events-provider-request-id` and the key-attribution link |
| `metadata` | optional (record) | all (tokenType, model, roomId/roomName, keySource, userId, ...) | Persisted; reserved keys enforced at the producer-ownership layer in `src/lib/usage-telemetry.ts`; idempotency basis is the shared contract, NOT including `project` or any other metadata |

## Coverage gaps and known honest limitations

1. **`project` is excluded from the idempotency basis** — by design (`AGENTS.md` "Per-project cost attribution").  Adding a `project` field to a v2 producer does not rekey existing events.  If you mirror `project` into the shared package's `UsageTelemetryV2EventSchema`, do not put it into `deriveUsageTelemetryIdempotencyKey`.
2. **BotFleet's `roomId`/`roomName`/driver hint ride `metadata` only** — they are not first-class fields.  This is intentional: the v2 schema is intentionally narrow, and the metadata bag is the producer-extension point.  If we ever want to query "all token events in a BotFleet room", we'd add a `roomId` column on `ExternalUsageEvent` (a separate UM-side change, not a wire change).
3. **OTLP host `system.*` metrics** are routed but **not persisted** by default (`OTLP_SYSTEM_METRICS_INGEST_ENABLED=false`).  Owners can opt in.  The reason: a single Coolify process exporting host gauges would write thousands of `ExternalUsageEvent` rows per tick (UM AGENTS.md "OTLP metrics" + "system-mapper").
4. **Socratic.Trade's `provider-call-volume` events are not token events.**  They are request counts, not LLM token counts.  The v2 schema is designed to accept both; `metricType: "usage"` with `unit: "request"` is the right shape.
5. **Per-producer scoped tokens** (`USAGE_INGEST_PRODUCER_TOKENS`) are optional and default off.  When `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true` is set, the unscoped `USAGE_INGEST_TOKEN` is denied — producers must use their scoped token.  This is the recommended posture for new producers.
6. **The four `_derivedCost*` metadata keys are reserved.**  Producers cannot set them; UM's `derive-ingest-cost.ts` is the only writer.  This is the producer spoof-proofing boundary.

## Verifying a new producer against this matrix

Before a new producer is wired:

1. Implement the producer side using `createUsageTelemetryV2Event` and `createUsageTelemetryClient` from `@jaywedgeworth22/congress-trading-shared`.
2. Send a single-event batch in dry-run mode to a local UM instance (`npm run dev`, `USAGE_MONITOR_INGEST_URL=http://localhost:3000/api/ingest/usage`).
3. Confirm `/api/ingest/usage` returns `200`, `attempted: 1`, `persisted: 1`, `duplicates: 0`, `rejected: 0`, `pruned: 0`.  Any non-zero `rejected` is a schema mismatch — read the typed error in the response body.
4. Replay the same batch and confirm `persisted: 0, duplicates: 1` — that proves idempotency works.
5. Add a row to the matrix above (PR, even if no code change).

## Update cadence

This matrix is updated every time a new producer lands or a producer changes its v2 event shape.  It is the canonical reference; the code comments at the top of `src/lib/usage-telemetry.ts` are the wire reference; the shared package `UsageTelemetryV2EventSchema` is the absolute truth.
