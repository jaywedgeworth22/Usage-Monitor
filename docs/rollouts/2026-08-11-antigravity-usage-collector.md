# 2026-08-11 — Google Antigravity quota collector (local, not GitHub Actions)

## Summary

A local collector script, not a new API route. Antigravity's per-model quota
only exists where the `agy` CLI is installed and authenticated — it reads
from the local Antigravity language server / cached Google Cloud Code OAuth
session, not a server-pollable API. A GitHub Actions runner (Gemini's
original suggestion) has neither, so it can only report fabricated numbers.
This pushes real readings through the **existing** generic ingest contract
instead of adding a bespoke endpoint.

## Why not the originally proposed design

An external draft proposed a new `pages/api/v1/telemetry/ingest.ts` route
plus a scheduled GitHub Action. Both are wrong for this repo:

- This app is Next.js **App Router** (`src/app/api/**/route.ts`), not Pages
  Router, and already has a versioned, idempotent, rate-limited generic
  ingest route at `POST /api/ingest/usage` (`src/lib/usage-telemetry.ts` /
  `src/app/api/ingest/usage/route.ts`). A second bespoke route would
  duplicate that contract instead of reusing it.
- A GitHub Actions runner cannot see the user's local Antigravity/`agy`
  session, so the proposed workflow could only ever push placeholder data
  (its own draft hardcoded `prompt_tokens: 0` / `quota_percentage: 100.0`).

## What ships here

- `scripts/antigravity-usage-collector.mjs` — runs
  `agy -p "/usage" --output-format json`, maps each per-model quota record to
  a v2 usage-telemetry event (`provider: "google-antigravity"`,
  `metricType: "quota"`), and POSTs a batch to
  `https://usage.jays.services/api/ingest/usage` with
  `x-usage-telemetry-version: 2`. Supports `--dry-run` (print, don't send)
  and `--debug` (dump the raw CLI output).
- `scripts/com.jays.antigravity-usage-collector.plist.example` — macOS
  launchd template to run it every 4h (inside Antigravity's ~5h Pro/Ultra
  quota refresh window) on the machine where Antigravity is actually used.
- `npm run antigravity:collect` — convenience alias for the script.

No server-side code changes were needed: `USAGE_INGEST_PRODUCER_TOKENS`
(`src/lib/ingest-auth.ts`) already supports adding an arbitrary
`producerId:token` pair without a deploy.

## Output shape

Confirmed via https://antigravity.google/docs/cli/headless: `agy -p "<any
prompt>" --output-format json` always wraps the result in a generic envelope
regardless of what was asked —

```json
{
  "conversation_id": "...",
  "status": "SUCCESS",
  "response": "...",
  "duration_seconds": 7.16,
  "num_turns": 1,
  "usage": { "input_tokens": ..., "output_tokens": ..., "total_tokens": ... }
}
```

The envelope's `usage` block is the token cost of *running the CLI query
itself* (e.g. what it cost to ask `/usage`) — it is unrelated to account
quota and the collector never sends it as telemetry. Per the antigravity-cli
changelog (v1.1.11), slash commands in print mode "emit one tab-separated
record per line," so the real per-model quota data lives inside `response`
as TSV text, which `parseUsageResponseText()` parses.

## KNOWN GAP — verify before scheduling

Google has not published the **column layout** of those tab-separated
records (only that a header + one row per model exists). The parser only
trusts a self-describing header row — it maps column names in `response`'s
first line via `COLUMN_ALIASES`, and with no recognizable header it dumps
the raw lines and refuses to guess a positional order rather than risk
mis-assigning fields.

**Before installing the launchd job:** run
`node scripts/antigravity-usage-collector.mjs --dry-run --debug` on the Mac
where `agy` is authenticated, compare the "raw CLI output" against the
"parsed events" it prints, and extend `COLUMN_ALIASES` in the script if the
real header wording doesn't match.

## Setup (owner)

1. **Infisical** — in the `usage-monitor` project
   (`86e35e51-91bc-4dfd-a045-4484726b9c40`), append a new pair to the
   `USAGE_INGEST_PRODUCER_TOKENS` secret value:
   `antigravity-cli:<new random token>` (comma-separated if other pairs
   already exist). The server picks this up on next restart via
   `scripts/infisical-run.mjs` — no code change, no separate secret name.
2. **Local Mac** — `infisical login` once (interactive, caches a session;
   this is why the plist can call `infisical run` without embedding a
   client secret). Confirm `agy` is on `PATH` and authenticated.
3. Dry-run: `infisical run --projectId 86e35e51-91bc-4dfd-a045-4484726b9c40 \
   --env prod -- node scripts/antigravity-usage-collector.mjs --dry-run --debug`
4. Once the parsed output looks right, install the launchd job (see the
   `.plist.example` header for exact steps) and drop `--dry-run`.

## Dashboard

`provider: "google-antigravity"` events show up in the existing telemetry
panels (`GET /api/usage-events`, `GET /api/llm-burn`) with no further code
changes — provider names are free-form strings. A `Provider` row (for a
monthly-budget card) is optional and out of scope here; mirror
`scripts/add-cursor-subscription.mjs` if/when wanted.
