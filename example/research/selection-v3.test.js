#!/usr/bin/env node
/**
 * Selection v3 research tests. Preserves the v2 suite by living in its own file.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const v2 = require("./selection-v2");
const v3 = require("./selection-v3");
const canonical = require("./observation/canonical");
const sensors = require("./observation/sensors");
const curve = require("./valuation/curve");
const adapters = require("./valuation/adapters");
const fees = require("./valuation/fees");
const rpc = require("./rpc-budget");
const { formatV3Report } = require("./selection-v3-report");
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

test("V2 result remains frozen", () => {
  const src = fs.readFileSync(path.join(__dirname, "selection-v2.js"), "utf8");
  assert.ok(src.includes('const NEW_MODEL = "selection-v2-shadow"'));
  assert.ok(src.includes("deployer -= 15"));
  assert.ok(src.includes("deployer -= 6"));
  assert.ok(!src.includes("100 - "));
  assert.strictEqual(v2.NEW_EPOCH, "selection_v2_shadow_2026_10");
  assert.strictEqual(v2.shrinkScore(10, 0), 50);
  const scored = v2.modelC({ deployerN: 4, rawScore: 80, launches1h: 9, creatorBuySol: 1, sameTxCreatorBuy: false, numSigners: 2 });
  assert.ok(scored.rankScore < 80);
});

test("V3 cannot submit", () => {
  const row = { id: "a", ts: 1, pnl: -1, deployerN: 2, rawScore: 40, mayhem: false };
  const model = v3.fitRisk([row]);
  const out = v3.selectionV3(row, model);
  assert.strictEqual(out.maySubmit, false);
  assert.strictEqual(out.executionImpact, "none");
  assert.ok(!("buySol" in out));
  assert.throws(() => adapters.raydiumAdapter().broadcast());
  assert.throws(() => adapters.jupiterAdapter().broadcast());
});

test("V3 cannot change live gate", () => {
  const judged = v3.judgeRisk([
    { passFold: true },
    { passFold: true },
    { passFold: true },
  ]);
  assert.strictEqual(judged.liveStatus, "UNCHANGED");
  assert.strictEqual(judged.liveRecommendation, null);
  assert.strictEqual(judged.shadowCanPromoteLive, false);
  assert.notStrictEqual(judged.researchVerdict, "PASS");
  assert.ok(judged.researchVerdict === "PASS_RISK_RESEARCH" || judged.researchVerdict === "FAIL_RISK_RESEARCH");
});

test("risk != opportunity score", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      id: "r" + i,
      ts: i,
      pnl: i % 2 ? -30 : -1,
      mae: -10,
      mfe: 1,
      deployerN: 2,
      rawScore: 30 + i,
      launches1h: 1,
      creatorBuySol: 0.4,
      creatorSol: 1,
      mayhem: false,
    });
  }
  const model = v3.fitRisk(rows);
  const out = v3.selectionV3(rows[0], model);
  assert.ok(out.riskScore == null || typeof out.riskScore === "number");
  assert.notStrictEqual(out.riskScore, out.opportunityScore);
  assert.strictEqual(out.opportunityScore, null);
});

test("low-risk does not imply high opportunity", () => {
  const row = {
    id: "low",
    ts: 1,
    pnl: 5,
    mae: -1,
    mfe: 12,
    deployerN: 8,
    rawScore: 90,
    launches1h: 0,
    creatorBuySol: 0.1,
    creatorSol: 2,
    mayhem: false,
    researchEpoch: "post_fix_v1",
  };
  const model = v3.fitRisk([row, { ...row, id: "b", pnl: -40, mae: -40, rawScore: 10 }]);
  const out = v3.selectionV3(row, model);
  assert.strictEqual(out.opportunityScore, null);
  assert.ok(out.abstainReason === "not_v3_epoch" || out.abstainReason === "insufficient_v3_train");
});

test("unknown feature abstention", () => {
  const model = v3.fitRisk([]);
  const scored = model.score({ id: "u", pnl: -1 });
  assert.strictEqual(scored.riskScore, null);
  assert.strictEqual(scored.abstainReason, "no_risk_features");
  const opp = v3.fitOpportunity([]).score({ researchEpoch: v3.V3_EPOCH, walletFlowDecision: {} });
  assert.strictEqual(opp.opportunityScore, null);
});

test("canonical observation dedupe", () => {
  const obs = canonical.reconcileObservations([
    { mint: "M", source: "helius_preprocessed", observedAt: 10, creator: "A", slot: 1 },
    { mint: "M", source: "logs", observedAt: 12, creator: "A", slot: 1 },
  ]);
  assert.strictEqual(obs.mint, "M");
  assert.strictEqual(obs.sourceCount, 2);
  assert.strictEqual(obs.conflicts.length, 0);
});

test("listener race reconciliation", () => {
  const hub = sensors.startSensorHub(
    {
      helius_preprocessed(emit) {
        emit({ mint: "M", observedAt: 1, creator: "A" });
      },
    },
    null
  );
  assert.ok(hub.skipped.includes("geyser"));
  assert.ok(hub.started.includes("helius_preprocessed"));
  const obs = hub.ingest({ mint: "M", source: "helius_processed", observedAt: 5, creator: "A", slot: 3 });
  assert.strictEqual(obs.sourceCount, 1);
});

test("source timestamps preserved", () => {
  const obs = canonical.reconcileObservations([
    { mint: "M", source: "helius_preprocessed", observedAt: 100, slot: 5, creator: "A" },
    { mint: "M", source: "helius_processed", observedAt: 140, slot: 5, creator: "A" },
  ]);
  assert.strictEqual(obs.sources[0].observedAt, 100);
  assert.strictEqual(obs.sources[1].observedAt, 140);
  assert.strictEqual(obs.preToProcessedMs, 40);
});

test("decision cutoff enforcement", () => {
  assert.strictEqual(canonical.cutoffAllows(100, 100), true);
  assert.strictEqual(canonical.cutoffAllows(101, 100), false);
});

test("after-cutoff wallet flow excluded", () => {
  const split = canonical.splitWalletFlow(
    {
      uniqueBuyers: { value: 4, observedAt: 50 },
      buySol: { value: 3, observedAt: 180 },
    },
    100
  );
  assert.strictEqual(split.decision.uniqueBuyers, 4);
  assert.ok(!("buySol" in split.decision));
  assert.strictEqual(split.descriptive.buySol, 3);
  assert.ok(split.excluded.includes("buySol"));
});

test("event-native quote mint decoding", () => {
  const keys = Array.from({ length: 16 }, (_, i) => "acct" + i);
  keys[16] = canonical.USDC_MINT;
  const q = canonical.quoteFromCreateV2Accounts(keys, { isCreateV2: true });
  assert.strictEqual(q.quoteMint, canonical.USDC_MINT);
  assert.strictEqual(q.quoteMintSource, "create_v2_remaining_account");
  assert.strictEqual(canonical.CREATE_V2_QUOTE_MINT_ACCOUNT_INDEX, 16);
});

test("create_v2 classification", () => {
  assert.strictEqual(canonical.classifyCreateVersion({ instruction: "Create_v2" }), "create_v2");
  assert.strictEqual(canonical.classifyCreateVersion({ instruction: "Create" }), "legacy");
  const native = canonical.quoteFromCreateV2Accounts([], { isCreateV2: true });
  assert.strictEqual(native.quoteMint, canonical.SOL_MINT);
  assert.strictEqual(native.createVersion, "create_v2");
});

test("custom pair classification", () => {
  const usdc = canonical.classifyQuote({ quoteMint: canonical.USDC_MINT });
  assert.strictEqual(usdc.quoteAssetClass, "USDC");
  assert.strictEqual(usdc.isCustomPair, true);
  const sol = canonical.classifyQuote({ quoteMint: canonical.SOL_MINT });
  assert.strictEqual(sol.isCustomPair, false);
  const custom = canonical.classifyQuote({ quoteMint: "MintCustom111" });
  assert.strictEqual(custom.quoteAssetClass, "CUSTOM");
  const stock = canonical.classifyQuote({ quoteMint: "StockMint" }, { StockMint: "TOKENIZED_ASSET" });
  assert.strictEqual(stock.quoteAssetClass, "TOKENIZED_ASSET");
});

test("LetsBonk platform classification", () => {
  assert.strictEqual(canonical.classifyPlatform({ instructionName: "initialize_v2" }), "lets_bonk");
  assert.strictEqual(canonical.classifyPlatform({ createVersion: "create_v2" }), "pump_fun");
  assert.ok(canonical.LETS_BONK_INIT_INSTRUCTIONS.has("initialize_with_token_2022"));
});

test("mayhem regime isolation", () => {
  assert.strictEqual(v3.isMayhemRegime({ mayhem: true }), true);
  const row = {
    researchEpoch: v3.V3_EPOCH,
    mayhem: true,
    walletFlowDecision: { uniqueBuyers: 5 },
    pnl: 1,
  };
  const fit = v3.fitOpportunity([
    { ...row, mayhem: false, id: "a", ts: 1, pnl: 1 },
    { ...row, mayhem: false, id: "b", ts: 2, pnl: -1, walletFlowDecision: { uniqueBuyers: 1 } },
  ]);
  const isolated = v3.fitOpportunity(
    Array.from({ length: 30 }, (_, i) => ({
      id: "t" + i,
      ts: i,
      researchEpoch: v3.V3_EPOCH,
      mayhem: false,
      pnl: i,
      walletFlowDecision: { uniqueBuyers: i, buyVelocity: 1, topBuyerShare: 0.2, experiencedWalletCount: 1, sourceCount: 2, curveProgress: 0.1 },
    }))
  );
  assert.strictEqual(isolated.ready, true);
  assert.strictEqual(isolated.score(row).abstainReason, "mayhem_separate_regime");
  assert.strictEqual(fit.ready, false);
});

test("curve progress parsing", () => {
  const state = {
    virtualSolReserves: 30_000_000,
    virtualTokenReserves: 1_000_000_000,
    realSolReserves: 42.5 * curve.LAMPORTS_PER_SOL,
    realTokenReserves: 1,
    complete: false,
  };
  assert.strictEqual(curve.calculateBuyTokensOut(state, 1_000_000), 32258064);
  assert.ok(Math.abs(curve.getBondingProgress(state) - 0.5) < 1e-9);
  const features = curve.curveFeatures(state, 10, "pump_curve");
  assert.strictEqual(features.observedAt, 10);
  assert.ok(features.distanceToGraduation > 0.4 && features.distanceToGraduation < 0.6);
  assert.strictEqual(curve.isGraduated({ complete: true, realSolReserves: 0 }), true);
});

test("migration classification", () => {
  assert.strictEqual(adapters.classifyVenue({ complete: true, poolProgram: "pumpswap" }), "PUMPSWAP");
  assert.strictEqual(adapters.classifyVenue({ complete: true, poolProgram: "raydium_cpmm" }), "RAYDIUM_CPMM");
  assert.strictEqual(adapters.classifyVenue({ virtualSolReserves: 1 }), "PUMP_CURVE");
  assert.strictEqual(adapters.classifyVenue({}), "UNKNOWN");
});

test("Pump curve shadow valuation", () => {
  const adapter = adapters.pumpCurveAdapter();
  const state = { virtualSolReserves: 30_000_000, virtualTokenReserves: 1_000_000_000, complete: false };
  assert.strictEqual(adapter.supports(state), true);
  assert.strictEqual(adapter.quoteEntry(state, 1_000_000).amountOut, curve.calculateBuyTokensOut(state, 1_000_000));
  assert.throws(() => adapter.broadcast());
});

test("PumpSwap shadow valuation", () => {
  const adapter = adapters.pumpSwapAdapter(0);
  const state = { baseReserve: 1_000_000, quoteReserve: 2_000_000 };
  const out = adapter.quoteEntry(state, 1_000);
  assert.ok(out.amountOut > 0);
  assert.ok(out.amountOut < state.baseReserve);
  assert.strictEqual(out.source, "pumpswap");
  assert.throws(() => adapter.broadcast());
});

test("Raydium simulation adapter cannot broadcast", () => {
  const adapter = adapters.raydiumAdapter();
  const state = { poolInfo: { id: "pool" }, reserveIn: 5_000_000, reserveOut: 5_000_000 };
  assert.strictEqual(adapter.supports(state), true);
  assert.ok(adapter.computeAmountOut(state, 1000) > 0);
  assert.strictEqual(adapter.simulate().broadcast, false);
  assert.throws(() => adapter.broadcast(), /broadcast is disabled/);
});

test("Jupiter adapter cannot broadcast", () => {
  const adapter = adapters.jupiterAdapter();
  const q = adapter.quoteEntry(null, { outAmount: 123, priceImpactPct: 0.1 });
  assert.strictEqual(q.amountOut, 123);
  assert.strictEqual(q.source, "jupiter");
  assert.throws(() => adapter.broadcast(), /broadcast is disabled/);
});

test("valuation disagreement reduces confidence", () => {
  const agreed = adapters.combineValuations([
    { source: "pump_curve", pnl: 1 },
    { source: "jupiter", pnl: 2 },
  ]);
  const split = adapters.combineValuations([
    { source: "pump_curve", pnl: 10 },
    { source: "jupiter", pnl: -20 },
  ]);
  assert.ok(split.confidence < agreed.confidence);
  assert.ok(split.missingReasons.includes("valuation_disagreement"));
  assert.notStrictEqual(split.pnl, 10);
  assert.strictEqual(split.pnl, -20);
});

test("priority-fee estimator uses median", () => {
  assert.strictEqual(fees.medianPriorityFeeMicroLamports([1, 100, 3]), 3);
  assert.notStrictEqual(fees.medianPriorityFeeMicroLamports([1, 100, 3]), 100);
  const bps = fees.estimatedAllInCostBps({
    notionalLamports: 1_000_000_000,
    recentPriorityFees: [1, 100, 3],
    estimatedCu: 200_000,
    priceImpactBps: 0,
  });
  assert.ok(bps > 0);
  assert.ok(bps < 50);
});

test("RPC enrichment cannot block observation", () => {
  const queue = rpc.createEnrichmentQueue();
  let ran = false;
  const snap = rpc.observeThenEnrich(
    { mint: "M", observedAt: 10, decisionCutoffAt: 10 },
    queue,
    () => {
      ran = true;
      return { curveProgress: 0.2 };
    }
  );
  assert.strictEqual(ran, false);
  assert.strictEqual(snap.decisionCutoffAt, 10);
  assert.deepStrictEqual(snap.postCutoff, {});
  queue.drain();
  assert.strictEqual(ran, true);
  assert.strictEqual(snap.decisionCutoffAt, 10);
  assert.strictEqual(snap.postCutoff.curveProgress, 0.2);
});

test("token bucket behavior", () => {
  let t = 0;
  const bucket = rpc.createTokenBucket({ capacity: 1, refillPerSec: 1, now: () => t });
  assert.strictEqual(bucket.tryTake(), true);
  assert.strictEqual(bucket.tryTake(), false);
  t = 1000;
  assert.strictEqual(bucket.tryTake(), true);
  assert.strictEqual(rpc.classifyRpcError(new Error("timed out")), "timeout");
});

test("temporal fold isolation", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: String(i), ts: (i + 1) * 1000 }));
  const folds = v3.walkForwardFolds(rows);
  assert.strictEqual(folds.length, 3);
  for (const fold of folds) v3.assertFoldIsolation(fold);
  assert.ok(folds[2].train.length > folds[0].train.length);
  assert.ok(folds[0].test[0].ts > folds[0].train[folds[0].train.length - 1].ts);
});

test("no future labels in features", () => {
  const flow = canonical.splitWalletFlow(
    { priorPnl: { value: 50, observedAt: 5000 } },
    1000
  );
  assert.ok(!("priorPnl" in flow.decision));
  const folds = v3.walkForwardFolds(Array.from({ length: 8 }, (_, i) => ({ id: String(i), ts: i + 1 })));
  v3.assertFoldIsolation(folds[1]);
});

test("risk target construction", () => {
  assert.strictEqual(v3.badTail({ pnl: -25, mae: -5, mfe: 1 }).catastrophic, true);
  assert.strictEqual(v3.badTail({ pnl: -5, mae: -31, mfe: 2 }).maeLe30, true);
  assert.strictEqual(v3.badTail({ pnl: -5, mae: -2, mfe: 3 }).catastrophic, false);
  const train = [];
  for (let i = 0; i < 40; i++) {
    const highBuy = i % 2 === 0;
    train.push({
      id: "c" + i,
      ts: i,
      pnl: highBuy ? -30 : -1,
      mae: highBuy ? -35 : -2,
      mfe: 1,
      deployerN: 3,
      rawScore: 40,
      launches1h: 1,
      creatorBuySol: highBuy ? 4 : 0.2,
      sameTxCreatorBuy: false,
      creatorSol: 1,
      mayhem: false,
    });
  }
  const model = v3.fitRisk(train);
  assert.ok(model.weights.creatorBuySol > 0);
});

test("opportunity rank cohort construction", () => {
  const train = Array.from({ length: 30 }, (_, i) => ({
    id: "o" + i,
    ts: i,
    researchEpoch: v3.V3_EPOCH,
    mayhem: false,
    pnl: i - 10,
    walletFlowDecision: {
      uniqueBuyers: 1 + (i % 5),
      buyVelocity: 1,
      topBuyerShare: 0.2,
      experiencedWalletCount: 1,
      sourceCount: 2,
      curveProgress: 0.2,
    },
  }));
  const model = v3.fitOpportunity(train);
  assert.strictEqual(model.ready, true);
  const standard = model.score(train[0]);
  assert.strictEqual(typeof standard.opportunityScore, "number");
  const mayhem = model.score({ ...train[0], mayhem: true });
  assert.strictEqual(mayhem.opportunityScore, null);
  assert.strictEqual(mayhem.abstainReason, "mayhem_separate_regime");
  const old = model.score({ ...train[0], researchEpoch: "post_fix_v1" });
  assert.strictEqual(old.abstainReason, "not_v3_epoch");
});

test("permutation deterministic", () => {
  const a = v3.deterministicShuffle([1, 2, 3, 4, 5, 6, 7, 8], 42);
  const b = v3.deterministicShuffle([1, 2, 3, 4, 5, 6, 7, 8], 42);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("bootstrap deterministic", () => {
  const x = bootstrapMedianDiff([1, 2, 8], [-2, -1, 0], { nBoot: 40, seed: 7 });
  const y = bootstrapMedianDiff([1, 2, 8], [-2, -1, 0], { nBoot: 40, seed: 7 });
  assert.deepStrictEqual(x, y);
});

test("ablation report", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({
      id: "a" + i,
      ts: i,
      pnl: i < 20 ? -30 : -1,
      mae: i < 20 ? -40 : -2,
      mfe: 1,
      deployerN: i < 20 ? 0 : 6,
      rawScore: i < 20 ? 10 : 80,
      launches1h: i < 20 ? 9 : 0,
      creatorBuySol: 0.5,
      creatorSol: 1,
      mayhem: false,
      sameTxCreatorBuy: false,
    });
  }
  const report = v3.ablation(rows.slice(0, 24), rows.slice(24));
  const names = report.rows.map((r) => r.family);
  assert.ok(names.includes("deployer"));
  assert.ok(names.includes("walletFlow"));
  const missing = report.rows.find((r) => r.family === "curve");
  assert.strictEqual(missing.note, "not_in_historical_decision_rows");
});

test("subgroup min-n behavior", () => {
  const small = v3.subgroupSlice(Array.from({ length: 10 }, (_, i) => ({ y: 1, id: i })), () => true);
  assert.strictEqual(small.status, "insufficient");
  const enough = v3.subgroupSlice(Array.from({ length: v3.SUBGROUP_MIN_N }, () => ({ y: 0 })), () => true);
  assert.strictEqual(enough.status, "ok");
});

test("V3 collector is telemetry and keeps the cutoff immutable", () => {
  const os = require("os");
  const v3c = require("./v3-collector");
  const file = path.join(os.tmpdir(), "v3-test-" + process.pid + ".jsonl");
  v3c.resetForTests();
  v3c.setTracePath(file);
  v3c.noteSource({
    mint: "MintA",
    source: "preprocessed",
    observedAt: 1_000,
    slot: 10,
    creator: "CreatorA",
    quoteMint: "So11111111111111111111111111111111111111112",
    createVersion: "legacy",
  });
  const snap = v3c.observeDecision({
    mint: "MintA",
    ts: 1_100,
    source: "preprocessed",
    creator: "CreatorA",
    deployer: "DeployerA",
    decision: "skip",
    skipReason: "shadow_observe_only",
    rawScore: 40,
    deployerN: 0,
    mayhem: false,
    createSlot: 10,
  });
  assert.strictEqual(snap.decisionCutoffAt, 1_100);
  assert.strictEqual(snap.opportunityScore, null);
  assert.strictEqual(snap.abstainReason, "insufficient_v3_features");
  assert.strictEqual(snap.maySubmit, false);
  assert.strictEqual(snap.researchEpoch, "selection_v3_shadow_2026_10");
  const late = v3c.noteSource({
    mint: "MintA",
    source: "txsub",
    observedAt: 2_000,
    slot: 11,
    creator: "CreatorA",
  });
  assert.strictEqual(late.afterDecision, true);
  assert.strictEqual(late.decisionCutoffAt, 1_100);
  const again = v3c.observeDecision({ mint: "MintA", ts: 3_000, decision: "skip", skipReason: "other" });
  assert.strictEqual(again.decisionCutoffAt, 1_100);
  const src = fs.readFileSync(path.join(__dirname, "v3-collector.js"), "utf8");
  assert.ok(!/sendTransaction\s*\(/.test(src));
  assert.strictEqual(v3c.executionSurface().maySubmit, false);
  v3c.resetForTests();
});

test("listener research hook cannot reach the buy path", () => {
  const listener = fs.readFileSync(path.join(__dirname, "..", "snipe-listener.ts"), "utf8");
  const infra = fs.readFileSync(path.join(__dirname, "..", "snipe-infra.ts"), "utf8");
  assert.ok(listener.includes('require("./research/v3-collector.js").noteSource'));
  assert.ok(infra.includes('require("./research/v3-collector.js").observeDecision'));
  const buyAt = listener.indexOf("async function buyMint");
  const handleAt = listener.indexOf("async function handleCreate");
  assert.ok(buyAt > 0 && handleAt > buyAt);
  const buyFn = listener.slice(buyAt, handleAt);
  assert.ok(!buyFn.includes("v3-collector"));
  assert.ok(!buyFn.includes("opportunityScore"));
  assert.ok(!buyFn.includes("riskScore"));
  const killAt = listener.indexOf("expectancyKillSwitch()");
  const killWindow = listener.slice(killAt, killAt + 400);
  assert.ok(!killWindow.includes("v3-collector"));
});

test("report cannot emit live recommendation", () => {
  const rows = [];
  for (let i = 0; i < 16; i++) {
    rows.push({
      id: "s" + i,
      ts: i * 1000,
      pnl: i % 3 === 0 ? -25 : -1,
      mae: -4,
      mfe: 1,
      oldScore: 50,
      deployerN: i % 2 === 0 ? 0 : 3,
      rawScore: 20 + i,
      launches1h: 1,
      creatorBuySol: 0.4,
      creatorSol: 1,
      mayhem: false,
      skipCohort: "other_skip",
      researchEpoch: "post_fix_v1",
    });
  }
  const rep = v3.evaluateProgram(rows);
  const text = formatV3Report(rep, null);
  assert.ok(text.includes("V3_STATUS = COLLECT_NEW_EPOCH"));
  assert.ok(text.includes("UNCHANGED"));
  assert.ok(!v3.FORBIDDEN_LIVE_TEXT.test(text));
  assert.strictEqual(rep.opportunity.decisionTimeFlowRows, 0);
  assert.throws(() =>
    formatV3Report({ ...rep, shadowCanPromoteLive: true, liveStatus: "UNCHANGED" }, null)
  );
});

console.log("");
console.log("results: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
