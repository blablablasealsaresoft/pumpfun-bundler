#!/usr/bin/env node
/**
 * Selection v3 research report. Never authorizes live trading.
 *   npm run research:model-v3
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { defaultPaths } = require("./records");
const { loadShadowRows } = require("./selection-v2-report");
const { loadV3CollectorRows } = require("./v3-collector-loader");
const v2 = require("./selection-v2");
const v3 = require("./selection-v3");

function fmt(x, d = 3) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

function pct(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return (100 * x).toFixed(1) + "%";
}

function formatV3Report(rep, baseline) {
  if (rep.shadowCanPromoteLive !== false || rep.liveStatus !== "UNCHANGED") {
    throw new Error("v3 report tried to change live status");
  }
  const lines = [];
  lines.push("RESEARCH ONLY — selection v3");
  lines.push("LIVE STATUS");
  lines.push("UNCHANGED");
  lines.push("");
  lines.push("V2 BASELINE (frozen FAIL_RESEARCH)");
  lines.push("model " + v2.NEW_MODEL + " epoch " + v2.NEW_EPOCH);
  if (baseline) {
    lines.push(
      "  held-out ex-stale rho pnl " +
        fmt(baseline.spearmanPnl) +
        " mono " +
        (baseline.mono && baseline.mono.label) +
        " top5 median pnl " +
        fmt(baseline.cohorts && baseline.cohorts.top5 && baseline.cohorts.top5.medianPnl, 2)
    );
  } else {
    lines.push("  prior held-out result stands: rho about 0.21 with MIXED cohorts and a worse top 5%");
  }
  lines.push("  positive correlation was a left-tail effect. It is not an opportunity ranker.");
  lines.push("");
  lines.push("V3 RISK MODEL");
  lines.push(rep.risk.researchVerdict);
  lines.push(
    "  folds passing " + rep.risk.passedFolds + " / " + rep.folds.length + " (need " + rep.risk.requiredFolds + ")"
  );
  for (const f of rep.folds) {
    lines.push(
      "  " +
        f.name +
        " n=" +
        f.n +
        " rho=" +
        fmt(f.rho) +
        " auc=" +
        fmt(f.auc) +
        " AP=" +
        fmt(f.averagePrecision) +
        " base=" +
        pct(f.baseRate) +
        " high-risk decile=" +
        pct(f.decileRate) +
        " lift=" +
        pct(f.lift) +
        " passFold=" +
        f.passFold
    );
  }
  lines.push("ablation (latest fold, train-only weights):");
  for (const a of rep.ablation) {
    lines.push(
      "  " +
        a.family +
        " deltaRho=" +
        fmt(a.deltaRho) +
        (a.note ? " " + a.note : " without=" + fmt(a.rhoWithout))
    );
  }
  lines.push("");
  const collector = rep.collector || {};
  lines.push("V3 COLLECTOR");
  lines.push("decisions: " + (collector.rawDecisions != null ? collector.rawDecisions : 0));
  lines.push("outcomes: " + (collector.outcomes != null ? collector.outcomes : 0));
  lines.push("joined valid: " + (collector.joinedValid != null ? collector.joinedValid : rep.opportunity.v3Rows || 0));
  lines.push("wallet flow decision-eligible: " + (collector.walletFlowEligible != null ? collector.walletFlowEligible : rep.opportunity.decisionTimeFlowRows || 0));
  lines.push("wallet flow + outcome effective: " + (collector.walletFlowOutcomeEffective != null ? collector.walletFlowOutcomeEffective : rep.opportunity.effectiveN || 0));
  lines.push("curve decision-eligible: " + (collector.curveEligible != null ? collector.curveEligible : 0));
  lines.push("leakage excluded: " + (collector.leakageExcluded != null ? collector.leakageExcluded : rep.opportunity.leakageExcluded || 0));
  lines.push("source overlap: " + (collector.sourceOverlap != null ? collector.sourceOverlap : 0));
  lines.push("high-confidence labels: " + (collector.highConfidenceLabels != null ? collector.highConfidenceLabels : rep.opportunity.highConfidenceN || 0));
  lines.push("multi-source labels: " + (collector.multiSourceLabels != null ? collector.multiSourceLabels : 0));
  lines.push("high-confidence means collector confidence >= 0.6 and not the single_source stamp. It is not a cross-venue validation.");
  if (collector.exclusions) {
    const ex = collector.exclusions;
    lines.push(
      "exclusions missing_pnl=" +
        ex.missing_pnl +
        " missing_mfe=" +
        ex.missing_mfe +
        " missing_mae=" +
        ex.missing_mae +
        " missing_wallet_flow=" +
        ex.missing_wallet_flow +
        " leakage=" +
        ex.leakage +
        " duplicate=" +
        ex.duplicate
    );
  }
  lines.push("");
  lines.push("V3 OPPORTUNITY MODEL");
  lines.push("status:");
  lines.push(rep.opportunity.status);
  lines.push("V3_STATUS = " + rep.opportunity.status);
  lines.push("effective new-epoch n: " + rep.opportunity.effectiveN);
  lines.push("walk-forward eligible: " + (rep.opportunity.walkForwardEligible ? "yes" : "no"));
  lines.push("opportunity_scored: " + rep.opportunity.opportunityScored);
  lines.push("opportunity_abstain: " + rep.opportunity.opportunityAbstain);
  lines.push("  " + rep.opportunity.reason);
  if (rep.opportunity.folds && rep.opportunity.folds.length) {
    lines.push("  all valid labels vs high-confidence labels (high-confidence is outcomeConfidence>=0.6 and not single_source):");
    for (const f of rep.opportunity.folds) {
      lines.push(
        "  " +
          f.name +
          " all-labels n=" +
          f.n +
          " rho pnl " +
          fmt(f.rhoPnl) +
          " rho mfe " +
          fmt(f.rhoMfe) +
          " | high-confidence n=" +
          f.highN +
          " rho pnl " +
          fmt(f.rhoPnlHighConfidence)
      );
      lines.push("  " + f.name + " fit features: " + ((f.fitFeatures && f.fitFeatures.length) ? f.fitFeatures.join(", ") : "none"));
      for (const v of f.variation || []) {
        lines.push(
          "    " +
            v.feature +
            " coverage_n=" +
            v.coverage_n +
            " unique_values=" +
            v.unique_values +
            " stddev=" +
            fmt(v.stddev) +
            " usable_for_fit=" +
            v.usable_for_fit +
            " reason=" +
            (v.reason || "varies")
        );
      }
    }
    lines.push("  walk-forward is descriptive. It is not PASS_OPPORTUNITY_RESEARCH.");
    if (!rep.opportunity.opportunityScored) {
      lines.push("  walk-forward fit produced no scores. Constant or missing opportunity features abstain.");
    }
  } else {
    lines.push("  rho pnl / mfe / kendall: not computed — effective new-epoch n is below the walk-forward gate");
  }
  if (rep.opportunity.passGate && rep.opportunity.passGate.reason === "MISSING_MAE_EVIDENCE") {
    lines.push("  pass gate: FAIL_OPPORTUNITY_RESEARCH MISSING_MAE_EVIDENCE");
  }
  lines.push("");
  lines.push("SUBGROUPS (latest risk-fold scores; small n is not interpreted)");
  for (const [name, g] of Object.entries(rep.subgroups)) {
    lines.push("  " + name + " n=" + g.n + " " + g.status + " catastrophic=" + pct(g.catastrophicRate));
  }
  lines.push("");
  lines.push("VERDICT");
  lines.push(rep.risk.researchVerdict);
  lines.push(rep.opportunity.researchVerdict);
  lines.push("LIVE STATUS");
  lines.push("UNCHANGED");
  const text = lines.join("\n");
  if (v3.FORBIDDEN_LIVE_TEXT.test(text)) throw new Error("forbidden live recommendation text");
  return text;
}

function main() {
  const paths = defaultPaths();
  const loaded = loadShadowRows(paths.decisionPath);
  const v3Path = path.join(path.dirname(paths.decisionPath), "v3-decisions.jsonl");
  const collector = loadV3CollectorRows(v3Path);
  const rep = v3.evaluateProgram({
    riskRows: loaded.rows,
    opportunityRows: collector.joined,
  });
  rep.collector = collector.summary;
  let baseline = null;
  try {
    const ex = loaded.rows.filter(v2.isExStale);
    const split = v2.temporalSplit(ex);
    baseline = v2.evaluateRanking(split.test, (r) => v2.modelC(r).rankScore, {
      reps: 40,
      nBoot: 80,
      seed: 42,
    });
  } catch (err) {
    baseline = null;
  }
  const text = formatV3Report(rep, baseline);
  fs.mkdirSync(paths.reportDir, { recursive: true });
  const out = path.join(paths.reportDir, "selection-v3.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        risk: rep.risk,
        opportunity: rep.opportunity,
        collector: rep.collector,
        folds: rep.folds,
        ablation: rep.ablation,
        subgroups: rep.subgroups,
        liveStatus: "UNCHANGED",
      },
      null,
      2
    )
  );
  console.log(text);
  console.log("");
  console.log("wrote " + out);
}

if (require.main === module) main();

module.exports = { formatV3Report };
