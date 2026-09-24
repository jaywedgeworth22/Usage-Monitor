# 2026-09-24 — Cost per board item (`GET /api/cost-by-session`)

Part of the Sentry agent-telemetry plan's "Next" horizon (see the eval report's
§3 "Cost per finished task" row): THE BOARD (mac-collab, `board claim/status/
comment --session <id>`) now records the Claude Code session id(s) that
worked a finding.  This gives Usage Monitor the other half — summing tokens
and API-equivalent cost across those session ids — so fleet mode's "cost per
finished task" metric is answerable instead of only aspirational.

## What changed

- **`src/lib/otlp/mapping-utils.ts`** — `session.id` is added to
  `METADATA_ALLOWLIST`.  It was previously deliberately excluded (see the
  removed comment); it is an opaque per-process UUID Claude Code mints for
  itself, not PII, and carries no prompt/response content, unlike
  `user.email` which stays excluded.  Existing rows ingested before this
  change simply have no `session.id` in `metadata` — nothing is backfilled.
- **`src/lib/cost-by-session.ts`** (new) — `loadCostBySessionRows` is a
  bounded SQLite aggregate (`$queryRaw` + `json_extract("metadata",
  '$."session.id"')`, same pattern as `external-usage-events.ts`'s
  `loadAnalyticsTokenRows` / `sumDerivedCostEstimates` and
  `key-attribution/route.ts`) grouped by session/metricType/unit/model/label —
  never a raw-row scan, matching the OOM lesson `llm-burn.ts`'s docblock
  documents.  `buildCostBySessionReport` is a pure reducer over those grouped
  rows into a per-session token/cost summary plus a total across all matched
  sessions.
- **`GET /api/cost-by-session?ids=a,b,c[&since=ISO][&until=ISO]`** (new) —
  dashboard-session gated like `GET /api/llm-burn` (no middleware exclusion,
  no bearer-token path).  `ids` accepts comma-separated and/or repeated
  params, capped at 100 distinct ids.  Window defaults to the trailing 180
  days, capped at 400 days, matching `/api/export/daily-rollups`'s
  reject-rather-than-clamp philosophy for an out-of-range request.
- **`src/components/CostBySessionPanel.tsx` + `src/app/cost-by-session/page.tsx`**
  (new) — a small card/table view.  Reads `?ids=` on mount so a link lands
  pre-filled; otherwise a seat pastes ids from `board show <id>`.  Linked from
  the nav under "Keys & apps" as "Cost by session".
- **THE BOARD (`~/apps/mac-collab/mac-collab-server.py`, local-only service,
  not this repo)** — a finding with recorded `session_ids` now shows a
  "Cost →" link to `https://usage.jays.services/cost-by-session?ids=<ids>`
  next to the existing session-count line.

## Cost semantics (unchanged contract)

Every number here traces back to Claude Code's own `claude_code.cost.usage`
OTLP metric — `billingMode="estimated"`, an API-equivalent estimate, never
cash, never read by budget math.  The response and the UI both carry
`costSemantics: "estimated_api_equivalent_not_authoritative"` so a consumer
can't mistake this for a budget figure.  Token counts (`claude_code.
token.usage`) are exact, not estimated.

## Verification performed

- `npm run lint` and `npm run typecheck` clean on the touched files (2
  pre-existing, unrelated `tsc` errors traced to a stray `/Users/jay/
  node_modules` directory shadowing this worktree's own — a local-machine
  artifact, not caused by this change; flagged separately, not fixed here).
- 116 tests green across every OTLP/cost-adjacent suite (`cost-by-session`,
  `claude-code-mapper`, `metrics-route` — including the updated allowlist
  test — `llm-burn`, `claude-cost-check`, `external-usage-*`,
  `otlp/system-mapper`, `otlp/bounded-log-once`, `logs-route`), plus the new
  route test's own dedicated ids/window validation cases.
- `buildCostBySessionReport` needs no wall-clock freeze — it has no `new
  Date()` inside it — so its unit tests use plain literal `Date` fixtures
  (see `wall-clock-test-rot` in the local Usage-Monitor memory notes for why
  that would matter for a function that *does* call `new Date()`).

## Not done here

- No backfill of `session.id` into rows ingested before this change.
- No Bearer/`USAGE_READ_TOKEN` path for this route (dashboard-session only,
  by design — matches `/api/llm-burn`, not the dual-auth routes).  A script
  that needs this data non-interactively would need that added first.
- The weekly fleet-mode compliance digest and Sentry deploy/release tagging
  (the plan's other "Next"/"Later" items) are separate PRs.
