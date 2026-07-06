# API Usage Monitor

Tracks API usage and cost across providers via **poller snapshots**, **pushed telemetry**, and **Claude Code OTLP metrics**. Deployed at `usage.jays.services`.

## Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/ingest/usage` | Ingest telemetry events from sibling apps (bearer token) |
| `GET` | `/api/budget-status` | Per-provider month-to-date spend vs monthly budget (read token) |
| `POST` | `/api/otlp/v1/metrics` | Receive OTLP metrics from Claude Code (same bearer token as ingest) |
| `GET` | `/api/sentry-health` | Per-project unresolved-issue counts from Sentry (dashboard-gated) |

## Quick start

```bash
npm install
cp .env.example .env          # fill in required values
npx prisma migrate dev
npm run dev
```

## Verify

```bash
npm run lint   # tsc --noEmit
npm test       # vitest run
npm run build  # next build
```

## Tech stack

- **Next.js** (App Router) — web framework
- **Prisma** (SQLite) — ORM + database (persistent disk on Render)
- **Render** — deployment (see `DEPLOY.md`)
- **Sentry** — error monitoring (Sentry Health card)

## Docs

- **[AGENTS.md](AGENTS.md)** — agent-facing guide (schema, auth, ingest flows, env vars)
- **[DEPLOY.md](DEPLOY.md)** — Render deployment instructions
