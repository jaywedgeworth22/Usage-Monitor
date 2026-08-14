# 2026-08-14 — Four Cloudflare accounts as UM providers

## Summary

Owner: add all 3–4 Cloudflare accounts to Usage Monitor.  Usage.Jays.Services
has its own token (not ST, CT, or Old).

Live `Provider` table had **zero** cloudflare rows.  Platforms/R2 already had
four account-id slots in env.  Nothing polled.

Boot now seeds four builtin rows:

| Name | Display | Account env | Token preference |
|---|---|---|---|
| `cloudflare-usage-jays` | Cloudflare (Usage.Jays.Services) | `R2_USAGE_ACCOUNT_ID` / `CLOUDFLARE_JAY_ACCOUNT_ID` | `CLOUDFLARE_JAY_API_TOKEN` first |
| `cloudflare-socratic` | Cloudflare (Socratic.Trade) | `CLOUDFLARE_ST_ACCOUNT_ID` | ST then fleet |
| `cloudflare-congress` | Cloudflare (Congress.Trade) | `CLOUDFLARE_CT_ACCOUNT_ID` | CT then fleet |
| `cloudflare-jay-old` | Cloudflare (Jay Old) | `CLOUDFLARE_OLD_ACCOUNT_ID` | Old then fleet (Old token absent; fleet works) |

`mustKeepFunded` is not touched.  Retired kimi/oracle rows are not touched.

## Files

- `src/lib/ensure-cloudflare-fleet-providers.ts`
- `src/lib/usage-recorder.ts` (boot hook)
- `src/lib/adapters/index.ts` (`cloudflare-*` → adapter)
- `src/lib/r2-usage.ts` (UJS token before fleet)

## Verification

Targeted vitest + `npx tsc --noEmit`.
