# 2026-09-04 — Quota windows API + antigravity-usage per-model remaining

**Why:** Owner wants onWatch-class remaining percent in Usage Monitor, and
BotFleet needs a machine-readable skip list so it does not use a model that
is already exhausted.

**Do not:** vendor GPL onWatch, reinstall EasyCLIProxyAPI as a live proxy, or
scrape consumer OAuth from Coolify.  LiteLLM (installed, unused) is a request
gateway; it does not read Claude/Codex/Antigravity subscription 5h/7d bars.

**What landed**

- `GET /api/quota-windows` (session cookie or `USAGE_READ_TOKEN`).  Latest
  `metricType=quota` events folded by series.  `skip` is true only when
  remaining is 0 or `isExhausted`.  Near-cap (≤20%) is a display status.
- Mac collector still runs `agy -p /usage` for group × window (5h / weekly).
  When `antigravity-usage` is on PATH it also posts per-model remaining,
  `resetTime`, and `isExhausted`.
- Fleet Quota Matrix no longer invents demo buckets.

**BotFleet sibling:** polls this URL for non-Antigravity engines.  Antigravity
reads `antigravity-usage` locally every minute.

**Board:** `109294fe`.  **Issue:** #1411.
