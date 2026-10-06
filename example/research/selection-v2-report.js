#!/usr/bin/env node
/**
 * Shadow-only old-vs-new selection report.
 * Never emits a live trading recommendation.
 *
 *   npm run research:model-v2
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadJsonl, defaultPaths } = require("./records");
const { RESEARCH_EPOCH, STATE_FIX_VERSION } = require("./promotion-protocol");
const v2 = require("./selection-v2");

function num(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function classifySkip(reason) {
  const r = reason || "";
  if (/stale create/i.test(r)) return "stale_create";
  if (/^kill /i.test(r) || /avgExecPnl/i.test(r) || /discrimination/i.test(r)) return "kill_gated";
  if (/mayhem/i.test(r)) return "mayhem";
  if (/creator SOL/i.test(r)) return "creator_sol";
  if (/admission/i.test(r) || /selection reject/i.test(r)) return "admission_floor";
  if (/slot lag/i.test(r)) return "slot_lag";
  if (/reserve|max concurrent/i.test(r)) return "capacity";
  if (/farm/i.test(r)) return "farm";
  return "other_skip";
}

function epochOk(row) {
  return (
    row.sampleSegment === "post_fix" ||
    row.researchEpoch === RESEARCH_EPOCH ||
    row.stateFixVersion === STATE_FIX_VERSION
  );
}

function loadShadowRows(decisionPath) {
  const raw = loadJsonl(decisionPath);
  const byMint = new Map();
  let skippedLive = 0;
  let skippedNoPnl = 0;
  let skippedEpoch = 0;
  for (const o of raw) {
    if (!o || !o.mint) continue;
    const reason = String(o.skipReason || "");
    const outcome = reason.includes("|outcome");
    if (o.decision === "buy" || !outcome) {
      if (o.decision === "buy") skippedLive++;
      continue;
    }
    if (!epochOk(o)) {
      skippedEpoch++;
      continue;
    }
    const pnl = num(o.ret30s);
    if (pnl == null) {
      skippedNoPnl++;
      continue;
    }
    const baseReason = reason.replace(/\|outcome$/, "");
    const row = {
      id: `${o.mint}|${o.createSig || ""}|${o.ts || 0}`,
      mint: o.mint,
      ts: num(o.ts) || 0,
      pnl,
      mfe: num(o.mfe30s),
      mae: num(o.mae30s),
      oldScore: num(o.effectiveScore) != null ? num(o.effectiveScore) : num(o.deployerScore),
      oldConfidence: num(o.confidence),
      rawScore: num(o.rawScore),
      deployerN: num(o.deployerN),
      creatorSol: num(o.creatorSol),
      creatorBuySol: num(o.creatorBuySol),
      sameTxCreatorBuy: o.sameTxCreatorBuy === true ? true : o.sameTxCreatorBuy === false ? false : null,
      launches1h: num(o.deployerLaunches1h),
      secsSincePriorLaunch: num(o.secsSincePriorLaunch),
      deployerPreviouslyProfitable: num(o.deployerPreviouslyProfitable),
      numSigners: num(o.numSigners),
      numInstructions: num(o.numInstructions),
      holderReward: o.holderReward === true ? true : o.holderReward === false ? false : null,
      mayhem: o.mayhem === true,
      buyFamily: o.buyFamily || null,
      isCustomPair: o.isCustomPair === true,
      quoteAsset: o.quoteAsset || null,
      quoteAssetClass: o.quoteAssetClass || null,
      priorLaunches: Array.isArray(o.priorLaunches) ? o.priorLaunches : null,
      skipCohort: o.skipCohort || classifySkip(baseReason),
      skipReason: baseReason,
    };
    const prev = byMint.get(row.mint);
    if (!prev || row.ts < prev.ts) byMint.set(row.mint, row);
  }
  const rows = v2.attachCausalContext([...byMint.values()]);
  return {
    rows,
    skippedLive,
    skippedNoPnl,
    skippedEpoch,
    decisionRows: raw.length,
  };
}

function fmt(x, d = 3) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

function pct(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return (100 * x).toFixed(1) + "%";
}

function block(name, ev) {
  if (!ev) return [name + ": n/a"];
  const c = ev.cohorts || {};
  const lines = [
    `${name}`,
    `  n: ${ev.n}  abstain: ${ev.abstain}`,
    `  rho pnl: ${fmt(ev.spearmanPnl)}   rho mfe: ${fmt(ev.spearmanMfe)}   kendall: ${fmt(ev.kendallPnl)} (n=${ev.kendallN})`,
    `  monotonicity: ${ev.mono ? ev.mono.label : "n/a"}  quartile med pnl: ${(ev.mono && ev.mono.medians ? ev.mono.medians : []).map((x) => fmt(x, 2)).join(" → ")}`,
    `  score collapse: ${ev.resolution && ev.resolution.flag ? ev.resolution.flag : "no"}  unique=${ev.resolution ? ev.resolution.unique_values : "n/a"}  pct_at_mode=${pct(ev.resolution && ev.resolution.pct_at_mode)}  mode=${ev.resolution ? ev.resolution.mode : "n/a"}`,
    `  top5 median pnl: ${fmt(c.top5 && c.top5.medianPnl, 2)}   top2: ${fmt(c.top2 && c.top2.medianPnl, 2)}   baseline: ${fmt(c.baseline && c.baseline.medianPnl, 2)}`,
    `  runner10 top5: ${pct(c.top5 && c.top5.runner10)}   baseline: ${pct(c.baseline && c.baseline.runner10)}`,
    `  mfe top5: ${fmt(c.top5 && c.top5.medianMfe, 2)}   baseline: ${fmt(c.baseline && c.baseline.medianMfe, 2)}`,
    `  mae top5: ${fmt(c.top5 && c.top5.medianMae, 2)}   baseline: ${fmt(c.baseline && c.baseline.medianMae, 2)}`,
  ];
  if (ev.bootstrapTop5MedianPnl) {
    const b = ev.bootstrapTop5MedianPnl;
    lines.push(`  bootstrap top5−rest median pnl: ${fmt(b.diff, 2)}  [${fmt(b.lo, 2)}, ${fmt(b.hi, 2)}]`);
  }
  if (ev.permutation) {
    lines.push(
      `  permutation: observed ${fmt(ev.permutation.observed)} vs null p95 ${fmt(ev.permutation.nullP95)}  beatsNull=${ev.permutation.beatsNull}`
    );
  }
  if (ev.tail) {
    lines.push(
      `  tail: ${ev.tail.label}  full=${fmt(ev.tail.fullRho)} drop1=${fmt(ev.tail.dropTop1)} drop2=${fmt(ev.tail.dropTop2)} drop5=${fmt(ev.tail.dropTop5)}`
    );
  }
  return lines;
}

function resolutionLines(title, resolution) {
  const r = resolution;
  return [
    title,
    `  n=${r.n} unique=${r.unique_values} pct_at_mode=${pct(r.pct_at_mode)} mode=${r.mode} std=${fmt(r.stddev, 2)} entropy=${fmt(r.entropy, 2)} ${r.flag || ""}`,
    `  p10=${fmt(r.p10, 1)} p25=${fmt(r.p25, 1)} p50=${fmt(r.p50, 1)} p75=${fmt(r.p75, 1)} p90=${fmt(r.p90, 1)} p95=${fmt(r.p95, 1)} p99=${fmt(r.p99, 1)}`,
  ];
}

function buildReport(loaded) {
  const rows = loaded.rows;
  const ex = rows.filter(v2.isExStale);
  const kill = rows.filter(v2.isKillGated);
  const split = v2.temporalSplit(ex);
  const linear = v2.fitLinearRank(split.train);
  const opts = { reps: 100, nBoot: 300, seed: 42 };

  const oldGet = (r) => r.oldScore;
  const models = {
    A_insample_ex_stale: v2.evaluateRanking(ex, oldGet, opts),
    A_heldout_ex_stale: v2.evaluateRanking(split.test, oldGet, opts),
    B_heldout_ex_stale: v2.evaluateRanking(split.test, (r) => v2.modelB(r).rankScore, opts),
    C_heldout_ex_stale: v2.evaluateRanking(split.test, (r) => v2.modelC(r).rankScore, opts),
    D_heldout_ex_stale: v2.evaluateRanking(split.test, (r) => linear.score(r).rankScore, opts),
    C_kill_gated: v2.evaluateRanking(kill, (r) => v2.modelC(r).rankScore, { reps: 50, nBoot: 200, seed: 42 }),
    A_kill_gated: v2.evaluateRanking(kill, oldGet, { reps: 50, nBoot: 200, seed: 42 }),
  };

  const evidenceTest = split.test.filter((r) => r.deployerN >= 1);
  models.A_heldout_evidence = v2.evaluateRanking(evidenceTest, oldGet, opts);
  models.C_heldout_evidence = v2.evaluateRanking(evidenceTest, (r) => v2.modelC(r).rankScore, opts);

  const verdict = v2.judge(models.C_heldout_ex_stale);
  const collapse = v2.explainScoreCollapse(ex);
  const oldRes = v2.scoreResolution(ex.map((r) => r.oldScore));
  const newScored = ex.map((r) => v2.modelC(r).rankScore).filter((x) => typeof x === "number");
  const newRes = v2.scoreResolution(newScored);

  const featureRows = [];
  for (const f of v2.LINEAR_FEATURES) {
    const train = v2.featureStandalone(split.train, f.get);
    const test = v2.featureStandalone(split.test, f.get);
    featureRows.push({
      name: f.name,
      trainN: train.n,
      trainCoverage: train.coverage,
      trainRhoPnl: train.spearmanPnl,
      trainRhoMfe: train.spearmanMfe,
      testRhoPnl: test.spearmanPnl,
      testRunnerQ4: train.quartiles[3] ? train.quartiles[3].runner10 : null,
      trainQMed: train.quartiles.map((q) => q.medianPnl),
      trainQMae: train.quartiles.map((q) => q.medianMae),
    });
  }

  const solBuckets = {};
  for (const name of v2.CREATOR_SOL_BUCKETS) {
    const slice = ex.filter((r) => r.creatorSolBucket === name);
    solBuckets[name] = {
      n: slice.length,
      medianPnl: slice.length ? v2.sliceStats(slice).medianPnl : null,
      runner10: slice.length ? v2.sliceStats(slice).runner10 : null,
      spearmanOld: v2.evaluateRanking(slice, oldGet, { reps: 0, nBoot: 20, seed: 42 }).spearmanPnl,
      spearmanNew: v2.evaluateRanking(slice, (r) => v2.modelC(r).rankScore, { reps: 0, nBoot: 20, seed: 42 }).spearmanPnl,
    };
  }

  const byQuote = {};
  for (const r of ex) {
    const k = (r.launch && r.launch.quoteAssetClass) || "unknown";
    if (!byQuote[k]) byQuote[k] = [];
    byQuote[k].push(r);
  }
  const quoteReport = {};
  for (const [k, slice] of Object.entries(byQuote)) {
    quoteReport[k] = {
      n: slice.length,
      isCustomPair: !!(slice[0].launch && slice[0].launch.isCustomPair),
      medianPnl: v2.sliceStats(slice).medianPnl,
      runner10: v2.sliceStats(slice).runner10,
      spearmanOld: v2.evaluateRanking(slice, oldGet, { reps: 0, nBoot: 20, seed: 42 }).spearmanPnl,
      spearmanNew: v2.evaluateRanking(slice, (r) => v2.modelC(r).rankScore, { reps: 0, nBoot: 20, seed: 42 }).spearmanPnl,
    };
  }

  const regimes = {};
  for (const name of ["hot", "normal", "cold", "unknown"]) {
    const slice = split.test.filter((r) => r.regime === name);
    regimes[name] = {
      n: slice.length,
      spearmanNew: slice.length >= 12
        ? v2.evaluateRanking(slice, (r) => v2.modelC(r).rankScore, { reps: 0, nBoot: 20, seed: 42 }).spearmanPnl
        : null,
      medianPnl: slice.length ? v2.sliceStats(slice).medianPnl : null,
    };
  }

  const priorSeriesN = ex.filter((r) => Array.isArray(r.priorLaunches) && r.priorLaunches.length).length;

  return {
    researchVerdict: verdict.researchVerdict,
    liveStatus: verdict.liveStatus,
    liveRecommendation: null,
    shadowCanPromoteLive: false,
    tradesSubmitted: false,
    killSwitchCodeTouched: false,
    liveBehaviorChanged: false,
    gate: verdict.gate,
    note:
      "Research criteria only. This verdict cannot promote live trading, disable the kill, or change execution.",
    counts: {
      shadowRows: rows.length,
      exStale: ex.length,
      killGated: kill.length,
      train: split.train.length,
      val: split.val.length,
      test: split.test.length,
      priorSeriesCoverage: priorSeriesN,
      skippedLive: loaded.skippedLive,
      skippedEpoch: loaded.skippedEpoch,
      skippedNoPnl: loaded.skippedNoPnl,
    },
    collapse,
    oldResolution: oldRes,
    newResolution: newRes,
    models,
    features: featureRows,
    unavailableFeatures: v2.UNAVAILABLE_FEATURES,
    creatorSol: solBuckets,
    quotes: quoteReport,
    regimes,
    linearWeights: linear.weights,
    epochs: {
      frozenBaselineEpoch: RESEARCH_EPOCH,
      oldModel: v2.OLD_MODEL,
      newModel: v2.NEW_MODEL,
      newEpoch: v2.NEW_EPOCH,
      featureVersion: v2.FEATURE_VERSION,
    },
  };
}

function formatReport(rep) {
  if (rep.researchVerdict !== "PASS_RESEARCH" && rep.researchVerdict !== "FAIL_RESEARCH") {
    throw new Error("research verdict must be PASS_RESEARCH or FAIL_RESEARCH");
  }
  if (rep.shadowCanPromoteLive !== false || rep.liveRecommendation != null) {
    throw new Error("shadow result tried to set a live recommendation");
  }
  const lines = [];
  lines.push("RESEARCH ONLY — selection shadow comparison");
  lines.push("live status: UNCHANGED");
  lines.push("kill switch code: untouched");
  lines.push("trades submitted by this report: no");
  lines.push(`old epoch (frozen): ${rep.epochs.frozenBaselineEpoch}  model ${rep.epochs.oldModel}`);
  lines.push(`new epoch: ${rep.epochs.newEpoch}  model ${rep.epochs.newModel}`);
  lines.push("");
  lines.push("SCORE COLLAPSE");
  lines.push(`  ${rep.collapse.mechanism}`);
  lines.push(
    `  ex-stale displayed-50: ${pct(rep.collapse.pctOldAt50)}   unknown deployer: ${pct(rep.collapse.unknownPct)}   unknown&50: ${rep.collapse.unknownAndDisplayed50}`
  );
  lines.push(
    `  shrink(10, n=0)=${rep.collapse.demo.shrinkUnknownLow}  shrink(90, n=0)=${rep.collapse.demo.shrinkUnknownHigh}  shrink(90, n=1)=${fmt(rep.collapse.demo.shrinkOneObs, 2)}`
  );
  lines.push(...resolutionLines("OLD displayed score (ex-stale)", rep.oldResolution));
  lines.push(...resolutionLines("NEW model C rank (known history only)", rep.newResolution));
  lines.push("");
  lines.push("OLD MODEL");
  lines.push(rep.epochs.oldModel);
  lines.push(...block("  in-sample ex-stale (descriptive)", rep.models.A_insample_ex_stale));
  lines.push(...block("  held-out ex-stale", rep.models.A_heldout_ex_stale));
  lines.push(...block("  held-out ex-stale, evidence n>=1 only", rep.models.A_heldout_evidence));
  lines.push("");
  lines.push("NEW MODEL");
  lines.push(rep.epochs.newModel + "  (model C, predeclared; unknowns abstain)");
  lines.push(...block("  held-out ex-stale", rep.models.C_heldout_ex_stale));
  lines.push(...block("  held-out evidence subset", rep.models.C_heldout_evidence));
  lines.push(...block("  model B held-out ex-stale (raw quality, no shrink)", rep.models.B_heldout_ex_stale));
  lines.push(...block("  model D held-out ex-stale (train-fit linear, exploratory)", rep.models.D_heldout_ex_stale));
  lines.push("");
  lines.push("SUBGROUPS");
  lines.push(...block("  kill-gated old", rep.models.A_kill_gated));
  lines.push(...block("  kill-gated model C", rep.models.C_kill_gated));
  lines.push("  creator SOL buckets (ex-stale, descriptive):");
  for (const [k, v] of Object.entries(rep.creatorSol)) {
    lines.push(
      `    ${k}: n=${v.n} medPnl=${fmt(v.medianPnl, 2)} runner10=${pct(v.runner10)} rhoOld=${fmt(v.spearmanOld)} rhoNew=${fmt(v.spearmanNew)}`
    );
  }
  lines.push("  launch structure (ex-stale, descriptive; custom pair only if explicitly flagged):");
  for (const [k, v] of Object.entries(rep.quotes)) {
    lines.push(
      `    ${k}: n=${v.n} customPair=${v.isCustomPair} medPnl=${fmt(v.medianPnl, 2)} runner10=${pct(v.runner10)} rhoOld=${fmt(v.spearmanOld)} rhoNew=${fmt(v.spearmanNew)}`
    );
  }
  lines.push("  held-out regime (creates in the prior 60s; outcomes only from launches already 30s old):");
  for (const [k, v] of Object.entries(rep.regimes)) {
    lines.push(`    ${k}: n=${v.n} medPnl=${fmt(v.medianPnl, 2)} rhoNew=${fmt(v.spearmanNew)}`);
  }
  lines.push("");
  lines.push("FEATURE COVERAGE (train discovery / test confirmation)");
  lines.push(`  prior outcome series on the decision row: ${rep.counts.priorSeriesCoverage} (recency decay not fit when this is 0)`);
  lines.push("  unavailable, not fabricated: " + rep.unavailableFeatures.join(", "));
  for (const f of rep.features) {
    lines.push(
      `  ${f.name}: coverage=${pct(f.trainCoverage)} n=${f.trainN} trainRhoPnl=${fmt(f.trainRhoPnl)} trainRhoMfe=${fmt(f.trainRhoMfe)} testRhoPnl=${fmt(f.testRhoPnl)}`
    );
  }
  lines.push("");
  lines.push("HELD-OUT RESULT");
  lines.push(rep.researchVerdict);
  lines.push("gate: " + (rep.gate.pass ? "met" : rep.gate.reasons.join(", ")));
  lines.push(rep.note);
  lines.push(
    `counts: shadow=${rep.counts.shadowRows} ex-stale=${rep.counts.exStale} kill-gated=${rep.counts.killGated} train/val/test=${rep.counts.train}/${rep.counts.val}/${rep.counts.test}`
  );
  const text = lines.join("\n");
  if (v2.FORBIDDEN_LIVE_TEXT.test(text)) throw new Error("forbidden live recommendation text");
  return text;
}

function main() {
  const paths = defaultPaths();
  const loaded = loadShadowRows(paths.decisionPath);
  const rep = buildReport(loaded);
  const text = formatReport(rep);
  const outDir = paths.reportDir;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "selection-v2.json");
  const dump = { ...rep, generatedAt: new Date().toISOString() };
  delete dump.models;
  dump.modelSummary = {};
  for (const [k, ev] of Object.entries(rep.models)) {
    dump.modelSummary[k] = {
      n: ev.n,
      abstain: ev.abstain,
      spearmanPnl: ev.spearmanPnl,
      spearmanMfe: ev.spearmanMfe,
      kendallPnl: ev.kendallPnl,
      mono: ev.mono && ev.mono.label,
      quartileMedians: ev.mono && ev.mono.medians,
      collapse: ev.resolution && ev.resolution.flag,
      pctAtMode: ev.resolution && ev.resolution.pct_at_mode,
      top5: ev.cohorts && ev.cohorts.top5,
      top2: ev.cohorts && ev.cohorts.top2,
      baseline: ev.cohorts && ev.cohorts.baseline,
      bootstrap: ev.bootstrapTop5MedianPnl,
      permutation: ev.permutation,
      tail: ev.tail,
    };
  }
  fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
  console.log(text);
  console.log("");
  console.log("wrote " + outPath);
}

if (require.main === module) main();

module.exports = {
  loadShadowRows,
  buildReport,
  formatReport,
  classifySkip,
};
