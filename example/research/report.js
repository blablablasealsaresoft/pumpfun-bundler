#!/usr/bin/env node
/**
 * Measurement-only promotion report.
 *
 *   npm run research:promotion
 *   node example/research/report.js [--epoch post_fix_v1] [--json path]
 *
 * Does not change live economic behavior.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { buildRecords, defaultPaths } = require("./records");
const { filterEffective, effectiveDeployerN } = require("./effective-n");
const {
  buildCohorts,
  monotonicityReport,
  correlations,
  evaluatePromotion,
} = require("./evaluate");
const {
  RESEARCH_EPOCH,
  DIAGNOSTIC_N,
  PROMOTION_N,
  MIN_CONV_WINDOW_N,
  STATUS,
} = require("./promotion-protocol");

function parseArgs(argv) {
  const out = { epoch: RESEARCH_EPOCH, json: null, decisions: null, exits: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--epoch") out.epoch = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--decisions") out.decisions = argv[++i];
    else if (a === "--exits") out.exits = argv[++i];
  }
  return out;
}

function fmt(x, d = 1) {
  return x == null || Number.isNaN(x) ? "n/a" : Number(x).toFixed(d);
}

function run(opts = {}) {
  const paths = defaultPaths();
  const decisionPath = opts.decisions || paths.decisionPath;
  const exitPath = opts.exits || paths.exitPath;
  const epoch = opts.epoch || RESEARCH_EPOCH;

  const { raw } = buildRecords({ decisionPath, exitPath, epochOnly: epoch });
  const filtered = filterEffective(raw, { epoch, selectedOnly: true });
  const deployerN = effectiveDeployerN(filtered.effective);
  const cohorts = buildCohorts(filtered.effective);
  const mono = monotonicityReport(cohorts);
  const corr = correlations(filtered.effective);
  const verdict = evaluatePromotion({
    effective: filtered.effective,
    deployerN,
    cohortBundle: cohorts,
    mono,
    corr,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    research_epoch: epoch,
    measurement_only: true,
    live_economics_unchanged: true,
    paths: { decisionPath, exitPath },
    raw_n: filtered.raw_n,
    effective_n: filtered.effective_n,
    effective_deployer_n: deployerN,
    exclusions: filtered.exclusions,
    requirements: {
      diagnostic_n: DIAGNOSTIC_N,
      promotion_n: PROMOTION_N,
      min_conv_window_n: MIN_CONV_WINDOW_N,
    },
    remaining_to_diagnostic: Math.max(0, DIAGNOSTIC_N - filtered.effective_n),
    remaining_to_promotion: Math.max(0, PROMOTION_N - filtered.effective_n),
    maxConvWindowN: cohorts.maxConvWindowN,
    baseline: cohorts.baseline,
    cohorts: Object.fromEntries(
      Object.entries(cohorts.cohorts).map(([k, v]) => {
        if (Array.isArray(v)) {
          return [
            k,
            v.map((c) => ({
              name: c.name,
              status: c.status,
              reason: c.reason,
              n: c.summary?.n ?? null,
              medianPnl: c.summary?.medianPnl ?? null,
              trimPnl: c.summary?.trimPnl ?? null,
              medianMfe: c.summary?.medianMfe ?? null,
              medianMae: c.summary?.medianMae ?? null,
              winRate: c.summary?.winRate ?? null,
              profitFactor: c.summary?.profitFactor ?? null,
            })),
          ];
        }
        return [
          k,
          {
            name: v.name,
            status: v.status,
            reason: v.reason,
            n: v.summary?.n ?? null,
            medianPnl: v.summary?.medianPnl ?? null,
            trimPnl: v.summary?.trimPnl ?? null,
            medianMfe: v.summary?.medianMfe ?? null,
            medianMae: v.summary?.medianMae ?? null,
            winRate: v.summary?.winRate ?? null,
            profitFactor: v.summary?.profitFactor ?? null,
          },
        ];
      })
    ),
    monotonicity: mono,
    correlations: corr,
    promotion: verdict,
    status: verdict.status,
  };

  return report;
}

function printHuman(report) {
  console.log(`RESEARCH STATUS: ${report.status}`);
  console.log("");
  console.log(`research_epoch: ${report.research_epoch}`);
  console.log(`raw_n: ${report.raw_n}`);
  console.log(`effective_n: ${report.effective_n}`);
  console.log(`effective_deployer_n: ${report.effective_deployer_n}`);
  console.log("");
  console.log("requirements:");
  console.log(`  diagnostic_n: ${report.requirements.diagnostic_n}`);
  console.log(`  promotion_n: ${report.requirements.promotion_n}`);
  console.log(`  min_conv_window_n: ${report.requirements.min_conv_window_n}`);
  console.log(`remaining_to_diagnostic: ${report.remaining_to_diagnostic}`);
  console.log(`remaining_to_promotion: ${report.remaining_to_promotion}`);
  console.log(`maxConvWindowN: ${report.maxConvWindowN}`);
  console.log("");
  console.log("exclusions:");
  for (const [k, v] of Object.entries(report.exclusions)) {
    if (v) console.log(`  ${k}: ${v}`);
  }
  console.log("");
  const b = report.baseline;
  console.log("baseline:");
  console.log(`  n: ${b?.n ?? 0}`);
  console.log(`  median pnl: ${fmt(b?.medianPnl)}%`);
  console.log(`  trim pnl: ${fmt(b?.trimPnl)}%`);
  console.log(`  median MFE: ${fmt(b?.medianMfe)}%`);
  console.log(`  median MAE: ${fmt(b?.medianMae)}%`);
  console.log(
    `  profit factor: ${
      b?.profitFactor == null
        ? "n/a"
        : b.profitFactor === Infinity
          ? "inf"
          : fmt(b.profitFactor, 2)
    }`
  );
  console.log("");
  console.log("ranking cohorts:");
  if (!report.maxConvWindowN || report.maxConvWindowN < report.requirements.min_conv_window_n) {
    console.log("  UNAVAILABLE — insufficient window depth (INSUFFICIENT_WINDOW_DEPTH)");
  } else {
    for (const [name, c] of Object.entries(report.cohorts)) {
      if (name === "quartiles") {
        for (const q of c) {
          console.log(
            `  ${q.name}: status=${q.status} n=${q.n} med=${fmt(q.medianPnl)} trim=${fmt(q.trimPnl)} mfe=${fmt(q.medianMfe)}`
          );
        }
      } else {
        console.log(
          `  ${c.name}: status=${c.status} n=${c.n} med=${fmt(c.medianPnl)} trim=${fmt(c.trimPnl)} mfe=${fmt(c.medianMfe)}`
        );
      }
    }
  }
  console.log("");
  console.log("monotonicity:");
  if (report.monotonicity.status === "NOT_EVALUATED") {
    console.log("  NOT EVALUATED");
  } else {
    console.log(`  medPnl=${report.monotonicity.medPnl}`);
    console.log(`  trimPnl=${report.monotonicity.trimPnl}`);
    console.log(`  medianMfe=${report.monotonicity.medianMfe}`);
    console.log(`  medianMae=${report.monotonicity.medianMae}`);
    console.log(`  winRate=${report.monotonicity.winRate}`);
  }
  console.log("");
  console.log("correlations:");
  console.log(
    `  spearman(pnl)=${fmt(report.correlations.spearmanPnl.rho, 3)} n=${report.correlations.spearmanPnl.n}`
  );
  console.log(
    `  spearman(mfe)=${fmt(report.correlations.spearmanMfe.rho, 3)} n=${report.correlations.spearmanMfe.n}`
  );
  console.log("");
  console.log("promotion:");
  console.log(`  ${report.promotion.status}`);
  console.log(`  ${report.promotion.detail || ""}`);
  if (report.promotion.reasonCodes?.length) {
    console.log(`  reasons: ${report.promotion.reasonCodes.join(", ")}`);
  }
  console.log("");
  console.log("next action:");
  if (report.status === STATUS.COLLECT) console.log("  COLLECT");
  else if (report.status === STATUS.DIAGNOSTIC)
    console.log("  COLLECT toward promotion-grade (n>=100); do not change live gates");
  else if (report.status === STATUS.PASS)
    console.log("  enable TOP2 live only @ fixed 0.025; compare live vs shadow");
  else if (report.status === STATUS.FAIL)
    console.log("  keep live gate OFF; improve deployer/selection model");
  else console.log("  INVALID — fix leakage/instrumentation before any promotion");
  console.log("");
  console.log(
    "HARD FREEZE: sizing/fees/Δ0/latency/dead/tranche/SL/max-hold/conviction-gate unchanged"
  );
}

function main() {
  const args = parseArgs(process.argv);
  const report = run(args);
  printHuman(report);

  const paths = defaultPaths();
  const outDir = paths.reportDir;
  fs.mkdirSync(outDir, { recursive: true });
  const latest = path.join(outDir, "latest.json");
  const stamped = path.join(
    outDir,
    `promotion-${report.research_epoch}-${Date.now()}.json`
  );
  const jsonPath = args.json || latest;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  if (!args.json) {
    fs.writeFileSync(stamped, JSON.stringify(report, null, 2));
  }
  console.log(`wrote ${jsonPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { run, printHuman, parseArgs };
