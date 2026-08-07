# 2026-08-07 — iOS no-budget card + Title Case copy (ST parity)

## Owner asks
1. Under the Over Budget / Remaining card: if no budget is set, **do not show a number** — value is **no budget set**.
2. Borrow Socratic.Trade capitalization: **Title Case** headings/buttons/chips; **sentence/lower** values.

## Bug fixed
Without a configured budget, `remaining = totalBudget − totalSpent` became **−spent**, so the Overview tile labeled **Over budget** and showed **$spent**. Now:
- `hasBudget` → Remaining / Over Budget with a dollar figure.
- `!hasBudget` → label **Budget**, value **no budget set** (no currency).

Same pattern on provider detail, alert detail, and Local overview.

## ST source
Socratic.Trade commit `e4e229e0` / `docs/rollouts/2026-08-07-ios-ui-title-case-copy.md`.  
Fleet rules mirrored in `docs/UI-COPY.md`.

## Surfaces touched
Dashboard (hero, stats, projection breakdown, chart range, intelligence), Providers list/detail, Alerts detail, Projects, Settings buttons, Local overview, shared ErrorState retry title.
