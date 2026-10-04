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
  const out = {
    epoch: RESEARCH_EPOCH,
    json: null,
    decisions: null,
    exits: null,
    universe: "both", // live_selected | shadow | both
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--epoch") out.epoch = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--decisions") out.decisions = argv[++i];
    else if (a === "--exits") out.exits = argv[++i];
    else if (a === "--universe") out.universe = argv[++i];
  }
  return out;
}

function fmt(x, d = 1) {
  return x == null || Number.isNaN(x) ? "n/a" : Number(x).toFixed(d);
}

function analyzeUniverse(raw, epoch, universe, excludeStaleShadow = false) {
  const filtered = filterEffective(raw, {
    epoch,
    universe,
    excludeStaleShadow,
  });
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
  const byCohort = {};
  if (universe === "shadow") {
    for (const r of filtered.effective) {
      const k = r.skipCohort || "other_skip";
      byCohort[k] = (byCohort[k] || 0) + 1;
    }
  }
  return {
    universe,
    raw_n: filtered.raw_n,
    effective_n: filtered.effective_n,
    effective_deployer_n: deployerN,
    exclusions: filtered.exclusions,
    skip_cohort_counts: byCohort,
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
}

function run(opts = {}) {
  const paths = defaultPaths();
  const decisionPath = opts.decisions || paths.decisionPath;
  const exitPath = opts.exits || paths.exitPath;
  const epoch = opts.epoch || RESEARCH_EPOCH;
  const universe = opts.universe || "both";

  const { raw } = buildRecords({ decisionPath, exitPath, epochOnly: epoch });

  const live = analyzeUniverse(raw, epoch, "live_selected");
  const shadow = analyzeUniverse(raw, epoch, "shadow", false);
  const shadowNoStale = analyzeUniverse(raw, epoch, "shadow", true);

  // INVARIANT: top-level operational status is ALWAYS live_selected.
  // Shadow may inform research sections only — never emit live PASS / live-trading advice.
  const report = {
    generatedAt: new Date().toISOString(),
    research_epoch: epoch,
    measurement_only: true,
    live_economics_unchanged: true,
    kill_switch_unchanged: true,
    note:
      "Shadow labels are counterfactual curve observations — never mixed into realized trading PnL and never set top-level operational status.",
    paths: { decisionPath, exitPath },
    requested_universe: universe,
    requirements: {
      diagnostic_n: DIAGNOSTIC_N,
      promotion_n: PROMOTION_N,
      min_conv_window_n: MIN_CONV_WINDOW_N,
    },
    live_selected: live,
    shadow_ranking: shadow,
    shadow_ranking_ex_stale: shadowNoStale,
    // Operational fields: live_selected only
    raw_n: live.raw_n,
    effective_n: live.effective_n,
    effective_deployer_n: live.effective_deployer_n,
    exclusions: live.exclusions,
    remaining_to_diagnostic: live.remaining_to_diagnostic,
    remaining_to_promotion: live.remaining_to_promotion,
    maxConvWindowN: live.maxConvWindowN,
    baseline: live.baseline,
    cohorts: live.cohorts,
    monotonicity: live.monotonicity,
    correlations: live.correlations,
    promotion: live.promotion,
    status: live.status,
    // Research-only shadow verdict (explicitly namespaced)
    shadow_status: shadow.status,
    shadow_promotion: shadow.promotion,
  };

  return report;
}

function printHuman(report) {
  console.log(`RESEARCH STATUS: ${report.status}  (live_selected universe)`);
  console.log("");
  console.log(`research_epoch: ${report.research_epoch}`);
  console.log(
    "note: kill switch unchanged; shadow labels are counterfactual only"
  );
  console.log("");
  console.log("--- live_selected (realized trades) ---");
  console.log(`effective_n: ${report.live_selected.effective_n}`);
  console.log(
    `remaining_to_diagnostic: ${report.live_selected.remaining_to_diagnostic}`
  );
  console.log(
    `remaining_to_promotion: ${report.live_selected.remaining_to_promotion}`
  );
  console.log(`maxConvWindowN: ${report.live_selected.maxConvWindowN}`);
  console.log(
    `baseline med pnl: ${fmt(report.live_selected.baseline?.medianPnl)}%`
  );
  console.log(`status: ${report.live_selected.status}`);
  console.log("");
  console.log("--- shadow_ranking (counterfactual, no trades) ---");
  console.log(`effective_n: ${report.shadow_ranking.effective_n}`);
  console.log(
    `effective_n ex-stale: ${report.shadow_ranking_ex_stale.effective_n}`
  );
  console.log(
    `remaining_to_diagnostic: ${report.shadow_ranking.remaining_to_diagnostic}`
  );
  console.log(`maxConvWindowN: ${report.shadow_ranking.maxConvWindowN}`);
  console.log(
    `baseline med pnl: ${fmt(report.shadow_ranking.baseline?.medianPnl)}%`
  );
  console.log(`mono medPnl: ${report.shadow_ranking.monotonicity?.medPnl}`);
  console.log(
    `spearman(pnl): ${fmt(report.shadow_ranking.correlations?.spearmanPnl?.rho, 3)} n=${report.shadow_ranking.correlations?.spearmanPnl?.n}`
  );
  console.log(
    `shadow_status (research only): ${report.shadow_status ?? report.shadow_ranking.status}`
  );
  if (report.shadow_ranking.skip_cohort_counts) {
    console.log("skip cohorts:");
    for (const [k, v] of Object.entries(report.shadow_ranking.skip_cohort_counts)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  console.log("");
  console.log("live_selected exclusions:");
  for (const [k, v] of Object.entries(report.live_selected.exclusions || {})) {
    if (v) console.log(`  ${k}: ${v}`);
  }
  console.log("");
  console.log("next action (from live_selected only):");
  if (report.status === STATUS.COLLECT) {
    console.log(
      "  COLLECT — live_selected stalled under kill is OK; accumulate shadow labels for ranking"
    );
  } else if (report.status === STATUS.DIAGNOSTIC)
    console.log("  COLLECT toward promotion-grade; do not change live gates");
  else if (report.status === STATUS.PASS)
    console.log("  enable TOP2 live only @ fixed 0.025; compare live vs shadow");
  else if (report.status === STATUS.FAIL)
    console.log("  keep live gate OFF; improve deployer/selection model");
  else console.log("  INVALID — fix leakage/instrumentation");
  if (
    report.shadow_status === STATUS.PASS ||
    report.shadow_status === STATUS.FAIL ||
    report.shadow_status === STATUS.DIAGNOSTIC
  ) {
    console.log(
      "  (shadow_status is research-only — does NOT authorize live trading)"
    );
  }
  console.log("");
  console.log(
    "HARD FREEZE: sizing/fees/Δ0/latency/dead/tranche/SL/max-hold/conviction-gate/kill unchanged"
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
