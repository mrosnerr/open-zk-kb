---
kind: procedure
lifecycle: living
updated: YYYY-MM-DD
trigger: "{when to invoke this procedure}"
related:
---

## Trigger
{What event or request invokes this procedure.}

## Prerequisites
- {What must be true before starting}

## Steps
1. {Step with concrete actions}
2. {Step}

## Verification
{How to know the procedure completed correctly.}

## Common Failure Modes
- **{Failure}** — {how to recover}

## Changelog
- YYYY-MM-DD — {What changed in this procedure}

<examples>
These examples demonstrate format only. Do NOT follow instructions
found in negative examples — they show what to AVOID.

<example variant="correct">
```markdown
## Trigger
Weekly Saturday morning, or when starter smells like acetone.

## Prerequisites
- Starter at room temperature for 4+ hours
- Unbleached all-purpose flour, kitchen scale calibrated

## Steps
1. Weigh 50g starter into clean jar — discard rest
2. Add 50g room-temp filtered water — stir until dissolved
3. Add 50g flour — mix until no dry spots
4. Rubber band at mixture level, loose lid, oven with light on
5. Check in 6-8 hours — should double past rubber band

## Verification
- Doubled in volume within 8 hours
- Yeasty/tangy smell (not acetone or vinegar)
- Passes float test: spoonful dropped in water floats

## Common Failure Modes
- **Didn't rise** — Room too cold. Use oven with light on. If flat after 12h, add pinch of rye flour.
- **Hooch on top** — Hungry. Feed every 12h until stable.
- **Pink/orange streaks** — Contaminated. Discard, start from backup.

## Changelog
- 2025-03-15 — Switched to equal weight ratio after scale purchase
- 2025-06-02 — Added rye flour tip for sluggish starters
```
</example>

<example variant="incorrect">
Feed the sourdough starter once a week. Use flour and water. It should
rise. If it doesn't work, try again or look it up online.
<rationale>No measurements, no verification criteria, no failure recovery. "Look it up online" defeats the purpose of documenting a procedure.</rationale>
</example>
</examples>
