/**
 * Join selection_v3_shadow_2026_10 collector rows for opportunity research.
 *
 * Join identity:
 *   preferred: mint + createSignature + decisionCutoffAt
 *   fallback:  mint + decisionCutoffAt
 *
 * Outcomes written before createSignature was stamped have no signature.
 * Those join only when exactly one decision shares that mint and cutoff.
 * Two decisions with the same mint and cutoff and no signed outcome are
 * ambiguous and are not joined. Mint alone is never a join key.
 *
 * Late source rows and after-cutoff curve or wallet-flow rows stay out of
 * decision features.
 */
"use strict";

const fs = require("fs");
const { loadJsonl } = require("./records");

const V3_EPOCH = "selection_v3_shadow_2026_10";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pairKey(mint, cutoff) {
  return String(mint) + "\0" + String(cutoff);
}

function fullKey(mint, signature, cutoff) {
  return String(mint) + "\0" + String(signature || "") + "\0" + String(cutoff);
}

function completeness(outcome) {
  return (num(outcome.pnl) != null ? 4 : 0) + (num(outcome.mfe) != null ? 2 : 0) + (num(outcome.mae) != null ? 1 : 0);
}

function pickDeterministic(rows, scoreOf) {
  return rows.slice().sort((a, b) => {
    const diff = scoreOf(b) - scoreOf(a);
    if (diff) return diff;
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  })[0];
}

function flowIsDecisionTime(flow, cutoff) {
  if (!flow || flow.decisionEligible !== true) return false;
  if (num(flow.lastIncludedObservedAt) != null && flow.lastIncludedObservedAt > cutoff) return false;
  return true;
}

function curveIsDecisionTime(curve, cutoff) {
  if (!curve || curve.decisionEligible !== true) return false;
  if (num(curve.observedAt) == null || curve.observedAt > cutoff) return false;
  return true;
}

function emptyExclusions() {
  return {
    missing_pnl: 0,
    missing_mfe: 0,
    missing_mae: 0,
    missing_wallet_flow: 0,
    leakage: 0,
    duplicate: 0,
    ambiguous_identity: 0,
    missing_outcome: 0,
  };
}

function isHighConfidenceLabel(row) {
  return (
    num(row.outcomeConfidence) != null &&
    row.outcomeConfidence >= 0.6 &&
    row.valuationSource &&
    row.valuationSource !== "single_source"
  );
}

function isEffectiveOpportunityRow(row) {
  if (!row || row.excludedForLeakage) return false;
  if (row.researchEpoch !== V3_EPOCH) return false;
  if (!flowIsDecisionTime(row.walletFlowDecision, row.decisionCutoffAt)) return false;
  if (typeof row.walletFlowDecision.uniqueBuyers !== "number") return false;
  if (num(row.pnl) == null || num(row.mfe) == null || num(row.mae) == null) return false;
  return true;
}

/**
 * @param {object[]} rawRows collector jsonl objects
 */
function joinV3CollectorRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const decisions = rows.filter((r) => r && r.type === "v3_decision" && r.researchEpoch === V3_EPOCH);
  const outcomes = rows.filter((r) => r && r.type === "v3_outcome" && r.researchEpoch === V3_EPOCH);
  const curves = rows.filter((r) => r && r.type === "v3_curve");
  const late = rows.filter((r) => r && r.type === "v3_source_late");
  const exclusions = emptyExclusions();

  const decisionsByPair = new Map();
  const decisionsByFull = new Map();
  for (const decision of decisions) {
    if (!decision.mint || num(decision.decisionCutoffAt) == null) {
      exclusions.ambiguous_identity++;
      continue;
    }
    const pair = pairKey(decision.mint, decision.decisionCutoffAt);
    if (!decisionsByPair.has(pair)) decisionsByPair.set(pair, []);
    decisionsByPair.get(pair).push(decision);
    const full = fullKey(decision.mint, decision.createSignature, decision.decisionCutoffAt);
    if (!decisionsByFull.has(full)) decisionsByFull.set(full, []);
    decisionsByFull.get(full).push(decision);
  }

  const outcomesByPair = new Map();
  const outcomesByFull = new Map();
  for (const outcome of outcomes) {
    if (!outcome.mint || num(outcome.decisionCutoffAt) == null) {
      exclusions.missing_outcome++;
      continue;
    }
    const pair = pairKey(outcome.mint, outcome.decisionCutoffAt);
    if (!outcomesByPair.has(pair)) outcomesByPair.set(pair, []);
    outcomesByPair.get(pair).push(outcome);
    if (outcome.createSignature) {
      const full = fullKey(outcome.mint, outcome.createSignature, outcome.decisionCutoffAt);
      if (!outcomesByFull.has(full)) outcomesByFull.set(full, []);
      outcomesByFull.get(full).push(outcome);
    }
  }

  const curvesByMint = new Map();
  for (const curve of curves) {
    if (!curve.mint) continue;
    if (!curvesByMint.has(curve.mint)) curvesByMint.set(curve.mint, []);
    curvesByMint.get(curve.mint).push(curve);
  }

  const joined = [];
  const ambiguousPairs = new Set();

  for (const [full, group] of decisionsByFull) {
    if (group.length > 1) exclusions.duplicate += group.length - 1;
    const decision = pickDeterministic(group, () => 0);
    const pair = pairKey(decision.mint, decision.decisionCutoffAt);
    const pairMates = decisionsByPair.get(pair) || [];
    const distinctSigs = new Set(pairMates.map((d) => d.createSignature || ""));
    let matched = outcomesByFull.get(full) || [];
    let joinKey = "mint+createSignature+decisionCutoffAt";
    if (!matched.length) {
      if (!decision.createSignature || distinctSigs.size !== 1) {
        if ((outcomesByPair.get(pair) || []).length) {
          if (!ambiguousPairs.has(pair)) exclusions.ambiguous_identity++;
          ambiguousPairs.add(pair);
        } else {
          exclusions.missing_outcome++;
        }
        continue;
      }
      matched = (outcomesByPair.get(pair) || []).filter((o) => !o.createSignature);
      joinKey = "mint+decisionCutoffAt";
      if (!matched.length) {
        exclusions.missing_outcome++;
        continue;
      }
    }
    if (matched.length > 1) exclusions.duplicate += matched.length - 1;
    const outcome = pickDeterministic(matched, completeness);
    const cutoff = decision.decisionCutoffAt;
    let leakage = (decision.leakageViolations || 0) > 0;

    let walletFlowDecision = null;
    if (decision.walletFlow && decision.walletFlow.decisionEligible === true) {
      if (num(decision.walletFlow.lastIncludedObservedAt) != null && decision.walletFlow.lastIncludedObservedAt > cutoff) {
        leakage = true;
      } else {
        walletFlowDecision = decision.walletFlow;
      }
    }

    const mintCurves = curvesByMint.get(decision.mint) || [];
    if (mintCurves.some((c) => c.decisionEligible === true && num(c.observedAt) != null && c.observedAt > cutoff)) {
      leakage = true;
    }
    const eligibleCurves = mintCurves.filter((c) => curveIsDecisionTime(c, cutoff));
    eligibleCurves.sort((a, b) => a.observedAt - b.observedAt || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const curveDecision = eligibleCurves.length ? eligibleCurves[eligibleCurves.length - 1] : null;

    if (leakage) exclusions.leakage++;
    if (num(outcome.pnl) == null) exclusions.missing_pnl++;
    if (num(outcome.mfe) == null) exclusions.missing_mfe++;
    if (num(outcome.mae) == null) exclusions.missing_mae++;
    if (!walletFlowDecision) exclusions.missing_wallet_flow++;

    joined.push({
      id: fullKey(decision.mint, decision.createSignature, cutoff),
      mint: decision.mint,
      createSignature: decision.createSignature || null,
      joinKey,
      researchEpoch: decision.researchEpoch,
      decisionCutoffAt: cutoff,
      ts: cutoff,
      pnl: num(outcome.pnl),
      mfe: num(outcome.mfe),
      mae: num(outcome.mae),
      runner10: outcome.runner10 === true ? true : outcome.runner10 === false ? false : null,
      walletFlowDecision,
      sourceTags: Array.isArray(decision.sourceTags) ? decision.sourceTags.slice() : [],
      sourceCountAtDecision: num(decision.sourceCountAtDecision) != null ? decision.sourceCountAtDecision : num(decision.sourceCount),
      sourceAgreementAtDecision: decision.sourceAgreementAtDecision ?? null,
      quoteMint: decision.quoteMint ?? null,
      quoteAssetClass: decision.quoteAssetClass ?? null,
      isCustomPair: decision.isCustomPair === true,
      mayhem: decision.mayhem === true,
      creatorSol: num(decision.creatorSol),
      creatorBuySol: num(decision.creatorBuySol),
      deployerRawQuality: num(decision.deployerRawQuality),
      deployerEvidenceN: num(decision.deployerEvidenceN),
      deployerConfidence: num(decision.deployerConfidence),
      curveDecision,
      venueAtDecision: decision.venueAtDecision ?? null,
      valuationSource: outcome.valuationSource ?? null,
      outcomeConfidence: num(outcome.confidence),
      excludedForLeakage: leakage,
      selected: false,
      sampleKind: "shadow",
      kind: "v3_shadow",
    });
  }

  joined.sort((a, b) => a.decisionCutoffAt - b.decisionCutoffAt || String(a.id).localeCompare(String(b.id)));

  const walletFlowEligible = decisions.filter((d) => flowIsDecisionTime(d.walletFlow, d.decisionCutoffAt) && typeof d.walletFlow.uniqueBuyers === "number").length;
  const effective = joined.filter(isEffectiveOpportunityRow);
  const joinedValid = joined.filter((r) => !r.excludedForLeakage && num(r.pnl) != null);
  const summary = {
    rawDecisions: decisions.length,
    outcomes: outcomes.length,
    lateSources: late.length,
    curveRows: curves.length,
    joined: joined.length,
    joinedValid: joinedValid.length,
    walletFlowEligible,
    walletFlowOutcomeEffective: effective.length,
    curveEligible: joined.filter((r) => r.curveDecision && !r.excludedForLeakage).length,
    sourceOverlap: joined.filter((r) => !r.excludedForLeakage && (r.sourceCountAtDecision || 0) >= 2).length,
    highConfidenceLabels: joined.filter((r) => !r.excludedForLeakage && num(r.pnl) != null && isHighConfidenceLabel(r)).length,
    multiSourceLabels: joined.filter((r) => !r.excludedForLeakage && typeof r.valuationSource === "string" && /multi|disagreement|\+/i.test(r.valuationSource)).length,
    leakageExcluded: exclusions.leakage,
    singleSourceLabels: joined.filter((r) => !r.excludedForLeakage && r.valuationSource === "single_source").length,
    exclusions,
    joinPolicy: "mint+createSignature+decisionCutoffAt, else unique mint+decisionCutoffAt",
  };

  return { decisions, outcomes, curves, late, joined, effective, summary };
}

function loadV3CollectorRows(v3Path) {
  const raw = v3Path && fs.existsSync(v3Path) ? loadJsonl(v3Path) : [];
  return joinV3CollectorRows(raw);
}

module.exports = {
  V3_EPOCH,
  joinV3CollectorRows,
  loadV3CollectorRows,
  isEffectiveOpportunityRow,
  isHighConfidenceLabel,
  flowIsDecisionTime,
  curveIsDecisionTime,
};
