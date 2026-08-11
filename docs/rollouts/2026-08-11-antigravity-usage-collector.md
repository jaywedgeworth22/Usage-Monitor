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

## KNOWN GAP — verify before scheduling

Google has not published a JSON schema for
`agy -p "/usage" --output-format json` (confirmed against antigravity.google
docs and the antigravity-cli changelog — the flag exists as of CLI v1.1.8,
non-interactive slash-command output as of v1.1.11, but no field reference).
The collector's `extractQuotaRecords()` is a best-effort reading of plausible
field names, and it fails loudly (dumps raw JSON, exits non-zero) rather than
sending guessed values if nothing recognizable is found.

**Before installing the launchd job:** run
`node scripts/antigravity-usage-collector.mjs --dry-run --debug` on the Mac
where `agy` is authenticated, compare the "raw CLI output" against the
"parsed events" it prints, and adjust the field-name aliases in
`extractQuotaRecords()`/`toTelemetryEvent()` if they don't line up.

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
