# Measurement-only promotion harness

**Does not change live economic behavior.**

Answers: does frozen selection/conviction ranking order candidates by forward outcome quality?

## Universes (never mixed)

| Universe | Meaning |
|----------|---------|
| `live_selected` | Real buys with completed executable exits (realized PnL) |
| `shadow` | Counterfactual curve labels for skips — **no trade submitted** |

Live kill switch may stall `live_selected` growth; shadow collection continues. Stale-create shadows are a distinct `skipCohort` (`stale_create`); use `--` ex-stale view for ranking that answers executable-time selection quality.

## Commands

```bash
npm run research:promotion
npm run test:research
```

## Stages (frozen)

| Stage | Condition | Status |
|-------|-----------|--------|
| A | `effective_n < 30` or `convWindowN < 100` | `COLLECT` |
| B | `effective_n >= 30` and window depth OK | `DIAGNOSTIC` (no live gate change) |
| C | `effective_n >= 100` | `PASS` or `FAIL` |

Operational COLLECT status tracks **live_selected**. Shadow ranking is reported alongside for research while the safety kill holds.

## Selection v2 (shadow only)

`deployer85-shrink-v1` stays the frozen baseline. `selection-v2-shadow` is a separate epoch (`selection_v2_shadow_2026_10`) and cannot set a live PASS.

```bash
npm run research:model-v2
```
