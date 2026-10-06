#!/usr/bin/env node
/**
 * Wallet-flow opportunity report. Does not change live status.
 *   npm run research:wallet-flow
 */
"use strict";

const path = require("path");
const { defaultPaths } = require("./records");
const flow = require("./wallet-flow-v1");
const { bookFromFile } = require("./wallet-flow-health");

function fmt(x, d = 3) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

function formatReport(rep) {
  if (rep.shadowCanPromoteLive !== false || rep.liveStatus !== "UNCHANGED" || rep.pass === true) {
    throw new Error("wallet-flow report tried to change live status");
  }
  const lines = [];
  lines.push("RESEARCH ONLY — wallet flow v1");
  lines.push("LIVE STATUS");
  lines.push("UNCHANGED");
  lines.push("epoch: " + flow.RESEARCH_EPOCH);
  lines.push("feature version: " + flow.FEATURE_VERSION);
  lines.push("prior epoch " + flow.PRIOR_EPOCH + " was not rewritten");
  lines.push("boundary: new rows start when wallet_flow_v1 collector notes the launch. Historical V3 rows stay in the prior epoch.");
  lines.push("");
  lines.push("status:");
  lines.push(rep.researchVerdict);
  lines.push("effective joined rows: " + rep.n);
  lines.push("mayhem rows reported separately: " + rep.mayhemN);
  lines.push("decision lag median ms: " + fmt(rep.leadLag.decisionLagMedianMs, 1));
  lines.push("100ms independent-flow eligible: " + fmt(rep.leadLag.eligible100));
  lines.push("250ms independent-flow eligible: " + fmt(rep.leadLag.eligible250));
  lines.push("500ms independent-flow eligible: " + fmt(rep.leadLag.eligible500));
  if (rep.postDecisionSignalOnly) {
    lines.push("POST_DECISION_SIGNAL_ONLY");
    lines.push("DESCRIPTIVE_ONLY windows are not decision-eligible and cannot pass.");
  }
  lines.push("");
  lines.push("FEATURE VARIATION");
  for (const row of rep.variation || []) {
    lines.push(
      "  " +
        row.feature +
        " coverage_n=" +
        row.coverage_n +
        " coverage_pct=" +
        fmt(row.coverage_pct) +
        " unique_values=" +
        row.unique_values +
        " stddev=" +
        fmt(row.stddev) +
        " p10=" +
        fmt(row.p10) +
        " p50=" +
        fmt(row.p50) +
        " p90=" +
        fmt(row.p90) +
        " fit_eligible=" +
        row.fit_eligible +
        " reason=" +
        (row.reason || "varies")
    );
  }
  lines.push("");
  for (const name of ["O0", "O1", "O2", "O3"]) {
    const model = (rep.models && rep.models[name]) || { status: "COLLECT_WALLET_FLOW", folds: [] };
    lines.push(name + " " + (model.status || "COLLECT_WALLET_FLOW"));
    for (const fold of model.folds || []) {
      lines.push(
        "  " +
          fold.name +
          " n=" +
          fold.n +
          " rho pnl " +
          fmt(fold.rhoPnl) +
          " rho mfe " +
          fmt(fold.rhoMfe) +
          " kendall " +
          fmt(fold.kendall) +
          (fold.abstainReason ? " abstain=" + fold.abstainReason : "")
      );
      const c = fold.cohorts || {};
      if (c.top5) {
        lines.push(
          "    top5 median pnl " +
            fmt(c.top5.medianPnl) +
            " runner10 " +
            fmt(c.top5.runner10) +
            " mfe " +
            fmt(c.top5.mfe) +
            " mae " +
            fmt(c.top5.mae) +
            " baseline " +
            fmt(c.baselineMedianPnl)
        );
      }
    }
  }
  lines.push("");
  lines.push("Shadow wallet-flow research cannot promote live.");
  lines.push("LIVE STATUS");
  lines.push("UNCHANGED");
  const text = lines.join("\n");
  if (/ENABLE LIVE|PROMOTE LIVE|TURN OFF KILL/.test(text)) throw new Error("forbidden live recommendation");
  return text;
}

function main() {
  const paths = defaultPaths();
  const file = path.join(path.dirname(paths.decisionPath), "v3-wallet-flow.jsonl");
  const book = bookFromFile(file);
  const rep = flow.evaluateBook(book);
  console.log(formatReport(rep));
}

if (require.main === module) main();

module.exports = { formatReport };
