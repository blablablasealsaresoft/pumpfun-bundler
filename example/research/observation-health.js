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
  const text = formatHealth(healthFromRows(rows));
  fs.mkdirSync(paths.reportDir, { recursive: true });
  const out = path.join(paths.reportDir, "observation-health.json");
  fs.writeFileSync(out, JSON.stringify(healthFromRows(rows), null, 2));
  console.log(text);
  console.log("wrote " + out);
}

if (require.main === module) main();

module.exports = { healthFromRows, formatHealth };
