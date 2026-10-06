#!/usr/bin/env node
/**
 * Selection-v2 shadow model tests. Research only.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const v2 = require("./selection-v2");
const { formatReport } = require("./selection-v2-report");
const { bootstrapMedianDiff } = require("./math");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name);
    console.error(e && e.stack ? e.stack : e);
  }
}

test("old model remains unchanged", () => {
  assert.strictEqual(v2.OLD_MODEL, "deployer85-shrink-v1");
  assert.strictEqual(v2.PRIOR_QUALITY, 50);
  assert.strictEqual(v2.PRIOR_WEIGHT, 8);
  assert.strictEqual(v2.shrinkScore(10, 0), 50);
  assert.strictEqual(v2.shrinkScore(90, 0), 50);
  assert.ok(Math.abs(v2.shrinkScore(90, 1) - (90 + 50 * 8) / 9) < 1e-9);
  const creator = path.join(__dirname, "..", "creator-cache.ts");
  const selection = path.join(__dirname, "..", "selection-model.ts");
  if (fs.existsSync(creator)) {
    const src = fs.readFileSync(creator, "utf8");
    assert.ok(src.includes("const PRIOR_QUALITY = 50"));
    assert.ok(src.includes("const PRIOR_WEIGHT = 8"));
  }
  if (fs.existsSync(selection)) {
    const src = fs.readFileSync(selection, "utf8");
    assert.ok(src.includes("wDeployer = 0.85"));
  }
});

test("new model cannot alter execution", () => {
  const scored = v2.modelC({
    deployerN: 4,
    rawScore: 80,
    launches1h: 1,
    creatorBuySol: 1.2,
    sameTxCreatorBuy: false,
    numSigners: 2,
  });
  assert.strictEqual(scored.executionImpact, "none");
  assert.strictEqual(scored.maySubmit, false);
  assert.ok(!("buySol" in scored));
  assert.ok(!("submit" in scored));
  const src = fs.readFileSync(path.join(__dirname, "selection-v2.js"), "utf8");
  assert.ok(!src.includes("snipe-listener"));
  assert.ok(!src.includes("sendTransaction"));
});

test("shadow remains unable to produce live PASS", () => {
  const judged = v2.judge({
    n: 500,
    spearmanPnl: 0.4,
    mono: { clear: true },
    cohorts: {
      top5: { medianPnl: 5, runner10: 0.4, medianMfe: 20, medianMae: -5 },
      baseline: { medianPnl: -2, runner10: 0.1, medianMfe: 1, medianMae: -8 },
    },
    resolution: { pct_at_mode: 0.1 },
    permutation: { beatsNull: true },
    tail: { dependent: false },
  });
  assert.strictEqual(judged.liveStatus, "UNCHANGED");
  assert.strictEqual(judged.liveRecommendation, null);
  assert.strictEqual(judged.shadowCanPromoteLive, false);
  assert.notStrictEqual(judged.researchVerdict, "PASS");
  assert.ok(judged.researchVerdict === "PASS_RESEARCH" || judged.researchVerdict === "FAIL_RESEARCH");
});

test("unknown deployer confidence is low", () => {
  const scored = v2.modelB({ deployerN: 0, rawScore: 88, effectiveScore: 50 });
  assert.strictEqual(scored.confidence, 0);
  assert.strictEqual(scored.evidenceN, 0);
  assert.strictEqual(scored.source, "prior");
  assert.strictEqual(scored.expectedQuality, null);
  assert.strictEqual(scored.rankScore, null);
});

test("score and confidence are independent", () => {
  const unknown = v2.modelB({ deployerN: 0, rawScore: 50 });
  const known = v2.modelB({ deployerN: 8, rawScore: 50 });
  assert.strictEqual(unknown.confidence, 0);
  assert.strictEqual(known.expectedQuality, 50);
  assert.ok(Math.abs(known.confidence - 0.5) < 1e-9);
  assert.notStrictEqual(unknown.confidence, known.confidence);
  assert.notStrictEqual(unknown.expectedQuality, known.expectedQuality);
});

test("no default 50 is treated as data-backed conviction", () => {
  const prior = v2.modelC({ deployerN: 0, rawScore: 35, effectiveScore: 50, oldScore: 50 });
  assert.strictEqual(v2.isDataBacked(prior), false);
  assert.strictEqual(prior.rankScore, null);
  const backed = v2.modelC({ deployerN: 3, rawScore: 50, launches1h: 0 });
  assert.strictEqual(v2.isDataBacked(backed), true);
  assert.ok(backed.confidence < 0.5);
});

test("CDF does not collapse sparse histories", () => {
  const rows = [
    { deployerN: 0, rawScore: 10 },
    { deployerN: 0, rawScore: 90 },
    { deployerN: 5, rawScore: 77 },
  ];
  const members = v2.cdfMembers(rows.map((r) => v2.modelB(r)));
  assert.deepStrictEqual(members, [77]);
  assert.strictEqual(v2.shrinkScore(10, 0), v2.shrinkScore(90, 0));
});

test("score resolution report works", () => {
  const collapsed = v2.scoreResolution(Array.from({ length: 100 }, () => 50));
  assert.strictEqual(collapsed.flag, "SCORE_COLLAPSE");
  assert.strictEqual(collapsed.unique_values, 1);
  assert.ok(collapsed.pct_at_mode >= 0.8);
  assert.strictEqual(collapsed.p50, 50);
  const spread = v2.scoreResolution([10, 20, 30, 40, 70, 80, 90]);
  assert.strictEqual(spread.flag, null);
  assert.ok(spread.unique_values >= 7);
  assert.ok(spread.entropy > 1);
});

test("leakage detection", () => {
  const reasons = v2.leakageReasons(
    [
      { name: "earlyBuyers", observedAt: 1500 },
      { name: "laterFlow", observedAt: 2500 },
      { name: "futurePath", kind: "future_wallet_flow", observedAt: 1000 },
    ],
    2000
  );
  assert.ok(reasons.some((r) => r.startsWith("after_cutoff:")));
  assert.ok(reasons.some((r) => r.startsWith("future_wallet_flow:")));
  assert.ok(!reasons.some((r) => r.includes("earlyBuyers")));
});

test("timestamp-bound feature inclusion", () => {
  const features = [
    { name: "seen", observedAt: 1000, value: 1 },
    { name: "late", observedAt: 1001, value: 2 },
  ];
  const kept = v2.decisionFeatures(features, 1000);
  assert.deepStrictEqual(kept.map((f) => f.name), ["seen"]);
  assert.strictEqual(v2.includeAtDecision(features[0], 1000), true);
  assert.strictEqual(v2.includeAtDecision(features[1], 1000), false);
});

test("future wallet flow cannot enter decision features", () => {
  const features = [
    { name: "futureBuyers", kind: "future_wallet_flow", observedAt: 500, value: 9 },
    { name: "sameTx", observedAt: 500, value: 1 },
  ];
  const kept = v2.decisionFeatures(features, 1000);
  assert.deepStrictEqual(kept.map((f) => f.name), ["sameTx"]);
});

test("ex-stale slicing", () => {
  const rows = [
    { skipCohort: "stale_create", id: "a" },
    { skipCohort: "kill_gated", id: "b" },
    { skipCohort: "other_skip", id: "c" },
  ];
  assert.deepStrictEqual(rows.filter(v2.isExStale).map((r) => r.id), ["b", "c"]);
});

test("kill-gated slicing", () => {
  const rows = [
    { skipCohort: "kill_gated", id: "k" },
    { skipCohort: "creator_sol", id: "c" },
  ];
  assert.deepStrictEqual(rows.filter(v2.isKillGated).map((r) => r.id), ["k"]);
});

test("creator-SOL buckets", () => {
  assert.strictEqual(v2.creatorSolBucket(0.027), "<0.05");
  assert.strictEqual(v2.creatorSolBucket(0.07), "0.05-0.10");
  assert.strictEqual(v2.creatorSolBucket(0.2), "0.10-0.25");
  assert.strictEqual(v2.creatorSolBucket(0.4), "0.25-0.50");
  assert.strictEqual(v2.creatorSolBucket(0.8), "0.50-1");
  assert.strictEqual(v2.creatorSolBucket(2), "1-5");
  assert.strictEqual(v2.creatorSolBucket(6), ">5");
  assert.strictEqual(v2.creatorSolBucket(null), null);
  assert.strictEqual(v2.CREATOR_SOL_BUCKETS.length, 7);
});

test("Custom Pair classification", () => {
  const custom = v2.classifyLaunch({ isCustomPair: true, quoteAsset: "TEST" });
  assert.strictEqual(custom.isCustomPair, true);
  assert.strictEqual(custom.quoteAssetClass, "custom_pair");
  const sol = v2.classifyLaunch({ buyFamily: "SOL_EXACT" });
  assert.strictEqual(sol.quoteAssetClass, "standard_sol");
  assert.strictEqual(sol.isCustomPair, false);
  const token = v2.classifyLaunch({ buyFamily: "TOKEN_EXACT" });
  assert.strictEqual(token.quoteAssetClass, "token_exact");
  assert.strictEqual(token.isCustomPair, false);
});

test("regime classification", () => {
  assert.strictEqual(v2.classifyRegime(0), "cold");
  assert.strictEqual(v2.classifyRegime(7), "cold");
  assert.strictEqual(v2.classifyRegime(8), "normal");
  assert.strictEqual(v2.classifyRegime(24), "normal");
  assert.strictEqual(v2.classifyRegime(25), "hot");
  const rows = v2.attachCausalContext([
    { id: "a", ts: 0, mfe: 20, pnl: 1 },
    { id: "b", ts: 1000, mfe: 0, pnl: -1 },
    { id: "c", ts: 62_000, mfe: 0, pnl: -1 },
  ]);
  assert.strictEqual(rows[0].createsPrior60s, 0);
  assert.strictEqual(rows[1].createsPrior60s, 1);
  assert.strictEqual(rows[2].createsPrior60s, 0);
  assert.strictEqual(rows[1].regime, "cold");
});

test("temporal train/test split", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i), ts: i * 1000 }));
  const split = v2.temporalSplit(rows);
  assert.strictEqual(split.train.length, 6);
  assert.strictEqual(split.val.length, 2);
  assert.strictEqual(split.test.length, 2);
  assert.ok(split.train[split.train.length - 1].ts < split.val[0].ts);
  assert.ok(split.val[split.val.length - 1].ts < split.test[0].ts);
  assert.deepStrictEqual(split.train.map((r) => r.id), ["0", "1", "2", "3", "4", "5"]);
});

test("deterministic bootstrap", () => {
  const a = [1, 2, 3, 8];
  const b = [-2, -1, 0, 1];
  const x = bootstrapMedianDiff(a, b, { nBoot: 50, seed: 42 });
  const y = bootstrapMedianDiff(a, b, { nBoot: 50, seed: 42 });
  assert.deepStrictEqual(x, y);
  assert.ok(x.diff > 0);
});

test("permutation test", () => {
  const scored = Array.from({ length: 40 }, (_, i) => ({ id: i, rankScore: i, pnl: i }));
  const hit = v2.permutationTest(scored, 40, 42);
  const again = v2.permutationTest(scored, 40, 42);
  assert.deepStrictEqual(hit, again);
  assert.strictEqual(hit.beatsNull, true);
  assert.ok(hit.observed > 0.9);
});

test("tail-dependence test", () => {
  const scored = [];
  for (let i = 0; i < 40; i++) {
    scored.push({
      id: i,
      rankScore: i < 35 ? 10 : 90 + i,
      pnl: i < 35 ? -1 : 50 + i,
      mfe: 0,
      mae: -5,
    });
  }
  const tail = v2.tailDependence(scored);
  assert.ok(tail.fullRho >= 0.15);
  assert.strictEqual(tail.dependent, true);
  assert.strictEqual(tail.label, "TAIL_DEPENDENT");
});

test("old/new paired comparison", () => {
  const rows = [
    {
      id: "mint-a",
      ts: 10,
      oldScore: 50,
      oldConfidence: 0,
      deployerN: 0,
      rawScore: 70,
      pnl: -1,
      mfe: 0,
      mae: -2,
    },
    {
      id: "mint-b",
      ts: 20,
      oldScore: 62,
      oldConfidence: 0.3,
      deployerN: 4,
      rawScore: 80,
      launches1h: 0,
      pnl: 3,
      mfe: 12,
      mae: -4,
    },
  ];
  const pairs = v2.pairedComparison(rows);
  assert.strictEqual(pairs[0].oldScore, 50);
  assert.strictEqual(pairs[0].newScore, null);
  assert.strictEqual(pairs[0].source, "prior");
  assert.strictEqual(pairs[1].oldScore, 62);
  assert.strictEqual(pairs[1].newScore, v2.modelC(rows[1]).rankScore);
  assert.notStrictEqual(pairs[1].oldScore, pairs[1].newScore);
  assert.strictEqual(pairs[0].oldModelVersion, "deployer85-shrink-v1");
  assert.strictEqual(pairs[0].newModelVersion, "selection-v2-shadow");
  assert.strictEqual(pairs[0].researchEpoch, "selection_v2_shadow_2026_10");
  assert.ok(pairs[0].oldScore !== undefined && pairs[0].newScore !== undefined);
});

test("report cannot emit live recommendation", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({
      id: "r" + i,
      ts: i * 1000,
      pnl: i % 5 === 0 ? 2 : -3,
      mfe: i % 7 === 0 ? 12 : -1,
      mae: -4,
      oldScore: 50,
      deployerN: i % 3 === 0 ? 0 : 2,
      rawScore: 40 + (i % 11),
      launches1h: i % 9,
      creatorSol: 0.2 + (i % 5) * 0.2,
      creatorBuySol: 0.4,
      sameTxCreatorBuy: i % 2 === 0,
      numSigners: 2,
      skipCohort: i % 4 === 0 ? "stale_create" : "other_skip",
      mayhem: false,
      buyFamily: i % 2 === 0 ? "SOL_EXACT" : "TOKEN_EXACT",
    });
  }
  const contextual = v2.attachCausalContext(rows);
  const rep = require("./selection-v2-report").buildReport({
    rows: contextual,
    skippedLive: 0,
    skippedEpoch: 0,
    skippedNoPnl: 0,
  });
  const text = formatReport(rep);
  assert.ok(text.includes("live status: UNCHANGED"));
  assert.ok(text.includes("FAIL_RESEARCH") || text.includes("PASS_RESEARCH"));
  assert.ok(!v2.FORBIDDEN_LIVE_TEXT.test(text));
  assert.strictEqual(rep.shadowCanPromoteLive, false);
  assert.strictEqual(rep.liveRecommendation, null);
  assert.throws(() =>
    formatReport({
      researchVerdict: "PASS",
      shadowCanPromoteLive: false,
      liveRecommendation: null,
    })
  );
});

console.log("");
console.log(`results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
