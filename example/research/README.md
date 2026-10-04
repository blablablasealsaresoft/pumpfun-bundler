# Measurement-only promotion harness

**Does not change live economic behavior.**

Answers one question: does frozen selection/conviction ranking order candidates by forward outcome quality?

## Commands

```bash
# Human + JSON report (reads ../../../wallets/*-traces.jsonl)
npm run research:promotion

# Deterministic unit tests
npm run test:research
```

## Stages (frozen)

| Stage | Condition | Status |
|-------|-----------|--------|
| A | `effective_n < 30` or `convWindowN < 100` | `COLLECT` |
| B | `effective_n >= 30` and window depth OK | `DIAGNOSTIC` (no live gate change) |
| C | `effective_n >= 100` | `PASS` or `FAIL` |

## PASS requires (predeclared)

- `baseline < top5 < top2` on median / trimmed / MFE-or-win proxy
- quartile monotonicity agreement
- top2 profit factor > 1
- MAE not materially worse up the ladder
- top2 still beats top5 after dropping 2 best tails
- bootstrap of top25 vs baseline not obviously contradictory
- no leakage flags

## Hard freeze

Do not change sizing, fees, Δ0, latency, dead/tranche, SL, max-hold, or conviction gate based on this harness.
