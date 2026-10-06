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
  lines.push("V3 OPPORTUNITY MODEL");
  lines.push("V3_STATUS = " + rep.opportunity.status);
  lines.push(rep.opportunity.researchVerdict);
  lines.push(
    "  v3 rows=" +
      rep.opportunity.v3Rows +
      " decision-time wallet-flow rows=" +
      rep.opportunity.decisionTimeFlowRows +
      " required=" +
      rep.opportunity.required
  );
  lines.push("  " + rep.opportunity.reason);
  lines.push("  rho pnl / mfe / kendall: not computed — new-epoch features are absent");
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
  const rep = v3.evaluateProgram(loaded.rows);
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
