# 2026-08-07 — iOS no-budget card + fleet Title Case copy

## Owner asks
1. Under the Over Budget / Remaining card: if no budget is set, **do not show a number** — value is **no budget set**.
2. Capitalization matches fleet rules in **`docs/FLEET-UI-COPY.md`** (mirror of `/Users/jay/apps/FLEET-UI-COPY.md`; same as ST `e4e229e0`).

## Bug fixed
Without a configured budget, `remaining = totalBudget − totalSpent` became **−spent**, so the Overview tile labeled **Over Budget** and showed **$spent**. Now:
- `hasBudget` → Remaining / Over Budget with a dollar figure.
- `!hasBudget` → label **Budget**, value **no budget set** (no currency).

Same pattern on provider detail, alert detail, and Local overview.

## Canon
- **Fleet:** `docs/FLEET-UI-COPY.md` — Title Case headings/buttons/chips; sentence/lower values; lowercase compact money suffixes.
- Do **not** invent a second copy guide (`docs/UI-COPY.md` removed).

## Surfaces touched
Dashboard (hero, stats, projection breakdown, chart range, intelligence), Providers list/detail, Alerts detail, Projects, Settings buttons, Local overview, shared ErrorState retry title.
