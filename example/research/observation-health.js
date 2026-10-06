#!/usr/bin/env node
/**
 * Coverage of decision-time fields. Missing V3 sensors stay missing.
 *   npm run research:observation-health
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadJsonl, defaultPaths } = require("./records");

function healthFromRows(rows) {
  const n = rows.length;
  const count = (pred) => rows.filter(pred).length;
  const sources = count((r) => Array.isArray(r.sources) && r.sources.length > 0);
  const quoteMint = count((r) => typeof r.quoteMint === "string" && r.quoteMint.length > 0);
  const wallet = count((r) => r.walletFlowDecision && typeof r.walletFlowDecision.uniqueBuyers === "number");
  const curve = count((r) => r.virtualSolReserves != null || (r.curve && r.curve.curveProgress != null));
  const venue = count((r) => typeof r.venueAtDecision === "string");
  const buyFamily = {};
  let mayhem = 0;
  let creator = 0;
  let creatorSol = 0;
  for (const r of rows) {
    const fam = r.buyFamily || "missing";
    buyFamily[fam] = (buyFamily[fam] || 0) + 1;
    if (r.mayhem === true) mayhem++;
    if (r.creator) creator++;
    if (typeof r.creatorSol === "number") creatorSol++;
  }
  return {
    n,
    sensorTagged: sources,
    quoteMint,
    walletFlowDecision: wallet,
    curve: curve,
    venueAtDecision: venue,
    mayhem,
    creator,
    creatorSol,
    buyFamily,
    v3EpochRows: count((r) => r.researchEpoch === "selection_v3_shadow_2026_10"),
  };
}

function summarizeV3(rows) {
  const decisions = rows.filter((r) => r.type === "v3_decision");
  const outcomes = rows.filter((r) => r.type === "v3_outcome");
  const late = rows.filter((r) => r.type === "v3_source_late");
  const curves = rows.filter((r) => r.type === "v3_curve");
  const curveEligible = curves.filter((r) => r.decisionEligible === true).length;
  const flowEligible = decisions.filter((r) => r.walletFlow && r.walletFlow.decisionEligible === true).length;
  const multi = decisions.filter((r) => (r.sourceCount || 0) >= 2).length;
  const quotes = {};
  let leakage = 0;
  for (const r of decisions) {
    const k = r.quoteAssetClass || "UNKNOWN";
    quotes[k] = (quotes[k] || 0) + 1;
    leakage += r.leakageViolations || 0;
  }
  const sources = {};
  for (const r of decisions) {
    for (const s of r.sourceTags || []) sources[s] = (sources[s] || 0) + 1;
  }
  return {
    epoch: "selection_v3_shadow_2026_10",
    observations: decisions.length,
    labels: outcomes.length,
    sources,
    sourceOverlap: multi,
    lateSources: late.length,
    quote: quotes,
    walletFlowEligible: flowEligible,
    curveRows: curves.length,
    curveEligible,
    leakageViolations: leakage,
    opportunityAbstain: decisions.filter((r) => r.opportunityScore == null).length,
  };
}

function formatV3Collector(v3) {
  if (!v3 || !v3.observations) {
    return [
      "V3 COLLECTOR",
      "epoch: selection_v3_shadow_2026_10",
      "observations: 0",
      "note: no new-epoch rows yet. Historical traces were not relabeled.",
    ].join("\n");
  }
  return [
    "V3 COLLECTOR",
    "epoch: " + v3.epoch,
    "observations: " + v3.observations,
    "labels: " + v3.labels,
    "sources: " + JSON.stringify(v3.sources),
    "source overlap: " + v3.sourceOverlap,
    "late sources: " + v3.lateSources,
    "quote coverage: " + JSON.stringify(v3.quote),
    "wallet flow decision-eligible: " + v3.walletFlowEligible,
    "curve rows: " + v3.curveRows + " decision-eligible: " + v3.curveEligible,
    "decision leakage violations: " + v3.leakageViolations,
    "opportunity abstain: " + v3.opportunityAbstain,
  ].join("\n");
}

function formatHealth(h) {
  const lines = [
    "OBSERVATION HEALTH",
    "n: " + h.n,
    "sensor-tagged rows: " + h.sensorTagged,
    "quoteMint coverage: " + h.quoteMint,
    "wallet-flow decision coverage: " + h.walletFlowDecision,
    "curve feature coverage: " + h.curve,
    "venueAtDecision coverage: " + h.venueAtDecision,
    "mayhem true: " + h.mayhem,
    "creator present: " + h.creator,
    "creatorSol present: " + h.creatorSol,
    "v3 epoch rows: " + h.v3EpochRows,
    "buyFamily: " + JSON.stringify(h.buyFamily),
    "note: zero coverage means the field was not stamped at decision time. It is not backfilled.",
  ];
  return lines.join("\n");
}

function main() {
  const paths = defaultPaths();
  const rows = fs.existsSync(paths.decisionPath) ? loadJsonl(paths.decisionPath) : [];
  const v3Path = path.join(path.dirname(paths.decisionPath), "v3-decisions.jsonl");
  const v3Rows = fs.existsSync(v3Path) ? loadJsonl(v3Path) : [];
  const v3 = summarizeV3(v3Rows);
  const text = formatHealth(healthFromRows(rows)) + "\n\n" + formatV3Collector(v3);
  fs.mkdirSync(paths.reportDir, { recursive: true });
  const out = path.join(paths.reportDir, "observation-health.json");
  fs.writeFileSync(out, JSON.stringify({ historical: healthFromRows(rows), v3 }, null, 2));
  console.log(text);
  console.log("wrote " + out);
}

if (require.main === module) main();

module.exports = { healthFromRows, formatHealth, summarizeV3, formatV3Collector };
