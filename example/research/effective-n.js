/**
 * effective_n definition + duplicate / exclusion accounting.
 *
 * A record counts toward effective_n iff ALL of:
 *  1. researchEpoch matches the declared epoch (default post_fix_v1)
 *  2. selected === true (live buy) OR has complete counterfactual outcome
 *  3. outcome.status === complete with realizedPnl number
 *  4. convictionScore (percentile) OR softFloorScore present at decision time
 *  5. not a duplicate of an earlier research identity / mint-buy
 *  6. no leakage flags
 *  7. decision not marked stale (selectionReason containing stale create after buy —
 *     buys that should have been aborted are excluded if flagged)
 */
"use strict";

const { RESEARCH_EPOCH } = require("./promotion-protocol");

function filterEffective(records, { epoch = RESEARCH_EPOCH, selectedOnly = true } = {}) {
  const exclusions = {
    wrong_epoch: 0,
    incomplete_outcome: 0,
    censored_outcome: 0,
    missing_outcome: 0,
    invalid_outcome: 0,
    missing_conviction: 0,
    duplicate: 0,
    stale_decision: 0,
    malformed: 0,
    leakage: 0,
    unselected: 0,
  };

  const seenMintBuy = new Set();
  const seenId = new Set();
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
    if (selectedOnly && !r.selected) {
      exclusions.unselected++;
      continue;
    }
    if (seenId.has(r.candidateId)) {
      exclusions.duplicate++;
      continue;
    }
    if (r.selected && r.mint) {
      const k = `buy:${r.mint}`;
      if (seenMintBuy.has(k)) {
        exclusions.duplicate++;
        continue;
      }
      seenMintBuy.add(k);
    }
    seenId.add(r.candidateId);

    if (
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
  };
}

/** Distinct deployers in an effective set */
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
