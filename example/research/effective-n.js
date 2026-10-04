/**
 * effective_n definition + duplicate / exclusion accounting.
 *
 * Universes (never mixed into each other for promotion denominators):
 *  - live_selected: real buys with complete executable exit outcomes
 *  - shadow: counterfactual curve labels for skips (no trade submitted)
 *
 * A record counts toward effective_n iff ALL of:
 *  1. researchEpoch / sampleSegment matches declared epoch
 *  2. sampleKind matches requested universe
 *  3. outcome.status === complete with realizedPnl number
 *  4. convictionScore OR softFloorScore present at decision time
 *  5. not a duplicate
 *  6. no leakage flags
 */
"use strict";

const { RESEARCH_EPOCH } = require("./promotion-protocol");

function filterEffective(
  records,
  {
    epoch = RESEARCH_EPOCH,
    universe = "live_selected", // "live_selected" | "shadow"
    excludeStaleShadow = false,
  } = {}
) {
  const exclusions = {
    wrong_epoch: 0,
    wrong_universe: 0,
    incomplete_outcome: 0,
    censored_outcome: 0,
    missing_outcome: 0,
    invalid_outcome: 0,
    missing_conviction: 0,
    duplicate: 0,
    stale_decision: 0,
    stale_shadow_cohort: 0,
    malformed: 0,
    leakage: 0,
  };

  const seenId = new Set();
  const seenMint = new Set();
  const effective = [];

  for (const r of records) {
    if (!r || !r.candidateId) {
      exclusions.malformed++;
      continue;
    }
    if (epoch === RESEARCH_EPOCH) {
      const okEpoch =
        r.researchEpoch === RESEARCH_EPOCH || r.sampleSegment === "post_fix";
      if (!okEpoch) {
        exclusions.wrong_epoch++;
        continue;
      }
    } else if (r.researchEpoch !== epoch) {
      exclusions.wrong_epoch++;
      continue;
    }
    if (r.leakageReasons && r.leakageReasons.length) {
      exclusions.leakage++;
      continue;
    }

    const kind =
      r.sampleKind ||
      (r.selected ? "live_selected" : "shadow");

    if (universe === "live_selected") {
      if (!r.selected && kind !== "live_selected") {
        exclusions.wrong_universe++;
        continue;
      }
    } else if (universe === "shadow") {
      if (r.selected || kind === "live_selected") {
        exclusions.wrong_universe++;
        continue;
      }
      if (excludeStaleShadow && r.skipCohort === "stale_create") {
        exclusions.stale_shadow_cohort++;
        continue;
      }
    }

    if (seenId.has(r.candidateId)) {
      exclusions.duplicate++;
      continue;
    }
    const mintKey = `${universe}:${r.mint || r.candidateId}`;
    if (r.mint && seenMint.has(mintKey)) {
      exclusions.duplicate++;
      continue;
    }
    seenId.add(r.candidateId);
    if (r.mint) seenMint.add(mintKey);

    if (
      universe === "live_selected" &&
      typeof r.selectionReason === "string" &&
      /stale create/i.test(r.selectionReason) &&
      r.selected
    ) {
      exclusions.stale_decision++;
      continue;
    }

    const hasScore =
      r.convictionScore != null ||
      r.softFloorScore != null ||
      r.rankScore != null;
    if (!hasScore) {
      exclusions.missing_conviction++;
      continue;
    }

    const st = r.outcome?.status;
    if (st === "censored") {
      exclusions.censored_outcome++;
      continue;
    }
    if (st === "missing") {
      exclusions.missing_outcome++;
      continue;
    }
    if (st === "invalid" || !r.outcome?.complete) {
      if (st === "invalid") exclusions.invalid_outcome++;
      else exclusions.incomplete_outcome++;
      continue;
    }
    if (typeof r.outcome.realizedPnl !== "number") {
      exclusions.incomplete_outcome++;
      continue;
    }

    effective.push(r);
  }

  return {
    raw_n: records.length,
    effective_n: effective.length,
    effective,
    exclusions,
    universe,
  };
}

function effectiveDeployerN(records) {
  const s = new Set();
  for (const r of records) {
    if (r.deployer) s.add(r.deployer);
  }
  return s.size;
}

module.exports = {
  filterEffective,
  effectiveDeployerN,
};
