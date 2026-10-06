#!/usr/bin/env node
/**
 * Counterfactual label quality. Single-source historical labels stay single-source.
 *   npm run research:label-quality
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { defaultPaths } = require("./records");
const { loadShadowRows } = require("./selection-v2-report");
const { combineValuations, highConfidence } = require("./valuation/adapters");

function labelQuality(rows) {
  let multi = 0;
  let disagree = 0;
  let high = 0;
  let single = 0;
  const examples = [];
  for (const r of rows) {
    const estimates = Array.isArray(r.valuations) ? r.valuations : null;
    if (!estimates || estimates.length < 2) {
      if (typeof r.pnl === "number") single++;
      continue;
    }
    multi++;
    const combined = combineValuations(estimates);
    if (combined.missingReasons.includes("valuation_disagreement")) disagree++;
    if (highConfidence(combined)) high++;
    if (examples.length < 3) examples.push(combined);
  }
  return {
    n: rows.length,
    singleSourceLabels: single,
    multiSourceLabels: multi,
    disagreements: disagree,
    highConfidence: high,
    examples,
    note:
      multi === 0
        ? "Historical shadow labels have one outcome field. PumpSwap, Raydium, and Jupiter cross-checks are not backfilled."
        : "Disagreement lowers confidence and the reported pnl is the median.",
  };
}

function formatLabelQuality(q) {
  return [
    "LABEL QUALITY",
    "n: " + q.n,
    "single-source labels: " + q.singleSourceLabels,
    "multi-source labels: " + q.multiSourceLabels,
    "disagreements: " + q.disagreements,
    "high-confidence multi-source: " + q.highConfidence,
    q.note,
  ].join("\n");
}

function main() {
  const paths = defaultPaths();
  const loaded = fs.existsSync(paths.decisionPath) ? loadShadowRows(paths.decisionPath) : { rows: [] };
  const q = labelQuality(loaded.rows);
  fs.mkdirSync(paths.reportDir, { recursive: true });
  const out = path.join(paths.reportDir, "label-quality.json");
  fs.writeFileSync(out, JSON.stringify({ ...q, examples: q.examples }, null, 2));
  console.log(formatLabelQuality(q));
  console.log("wrote " + out);
}

if (require.main === module) main();

module.exports = { labelQuality, formatLabelQuality };
