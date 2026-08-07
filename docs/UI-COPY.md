# Usage Monitor — UI copy rules (fleet)

**Borrowed from Socratic.Trade** (`docs/rollouts/2026-08-07-ios-ui-title-case-copy.md`, commit `e4e229e0`).  
Same owner preference for all jays.services apps.

## Rules

| Surface | Case | Examples |
|---------|------|----------|
| **Headings, section titles, buttons, status chips** | **Title Case** | Needs Attention, Over Budget, Edit Budget, Try Again, Chart Range, Projected End of Month |
| **Values / answers / secondary captions** | **sentence or lower case** | no budget set, usage pace, all on track, of $250, list-price value, every 15 min |

## Do not

- Put a **dollar remaining / over** figure when **no budget is set**. Value is the answer: `no budget set` (not `$X.XX` with a “no budget” footnote).
- Title-Case settings *values* (`Ask-First` as a LabeledContent value → use `ask-first`; keep Title Case only on chips next to headings if needed).

## iOS notes

- `StatTile.label` = Title Case (heading-like).
- `StatTile.value` / `secondary` = numbers or sentence/lower.
- List row *subtitles* under provider names are values → sentence/lower (`over by $12`, `on track`).
- Status badges on heroes are chips → Title Case (`Over Budget`, `On Track`).

## Web

Prefer the same split for card titles vs metric secondary lines when touching Overview copy.
