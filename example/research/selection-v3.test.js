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
const { joinV3CollectorRows } = require("./v3-collector-loader");
const { filterEffective } = require("./effective-n");
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

function v3Decision(partial) {
  const row = {
    type: "v3_decision",
    researchEpoch: "selection_v3_shadow_2026_10",
    mint: "MintA",
    createSignature: "SigA",
    decisionCutoffAt: 1_000,
    leakageViolations: 0,
    sourceTags: ["helius_preprocessed"],
    sourceCountAtDecision: 1,
    sourceAgreementAtDecision: true,
    quoteMint: "So11111111111111111111111111111111111111112",
    quoteAssetClass: "SOL",
    isCustomPair: false,
    mayhem: false,
    creatorSol: 1,
    creatorBuySol: 0.4,
    deployerRawQuality: 40,
    deployerEvidenceN: 2,
    deployerConfidence: 0.2,
    walletFlow: {
      uniqueBuyers: 2,
      buyCount: 2,
      buySol: 0.8,
      decisionEligible: true,
      lastIncludedObservedAt: 1_000,
      windowMs: 250,
    },
    ...partial,
  };
  if (!partial || !Object.prototype.hasOwnProperty.call(partial, "walletFlow")) {
    row.walletFlow = { ...row.walletFlow, lastIncludedObservedAt: row.decisionCutoffAt };
  }
  return row;
}

function v3Outcome(partial) {
  return {
    type: "v3_outcome",
    researchEpoch: "selection_v3_shadow_2026_10",
    mint: "MintA",
    decisionCutoffAt: 1_000,
    pnl: -1.5,
    mfe: 4,
    mae: -3,
    runner10: false,
    valuationSource: "pump_curve",
    confidence: 0.6,
    ...partial,
  };
}

test("V3 decision and outcome join on mint cutoff when signature is absent", () => {
  const joined = joinV3CollectorRows([
    v3Decision(),
    v3Outcome(),
    { type: "v3_source_late", mint: "MintA", source: "helius_processed", observedAt: 5_000, decisionCutoffAt: 1_000, afterDecision: true },
  ]);
  assert.strictEqual(joined.joined.length, 1);
  assert.strictEqual(joined.joined[0].joinKey, "mint+decisionCutoffAt");
  assert.strictEqual(joined.joined[0].pnl, -1.5);
  assert.strictEqual(joined.joined[0].walletFlowDecision.uniqueBuyers, 2);
  assert.deepStrictEqual(joined.joined[0].sourceTags, ["helius_preprocessed"]);
  assert.strictEqual(joined.summary.lateSources, 1);
});

test("identity collision is not joined by mint alone", () => {
  const rows = joinV3CollectorRows([
    v3Decision({ createSignature: "SigA" }),
    v3Decision({ createSignature: "SigB" }),
    v3Outcome(),
  ]);
  assert.strictEqual(rows.joined.length, 0);
  assert.ok(rows.summary.exclusions.ambiguous_identity >= 1);
  const signed = joinV3CollectorRows([
    v3Decision({ createSignature: "SigA" }),
    v3Decision({ createSignature: "SigB" }),
    v3Outcome({ createSignature: "SigB", pnl: -7 }),
  ]);
  assert.strictEqual(signed.joined.length, 1);
  assert.strictEqual(signed.joined[0].createSignature, "SigB");
  assert.strictEqual(signed.joined[0].pnl, -7);
  assert.strictEqual(signed.joined[0].joinKey, "mint+createSignature+decisionCutoffAt");
});

test("walletFlow maps to walletFlowDecision only when decision-eligible", () => {
  const ok = joinV3CollectorRows([v3Decision(), v3Outcome()]);
  assert.ok(ok.joined[0].walletFlowDecision);
  assert.strictEqual(ok.joined[0].walletFlowDecision.decisionEligible, true);
  const lateFlow = joinV3CollectorRows([
    v3Decision({
      walletFlow: { uniqueBuyers: 4, decisionEligible: true, lastIncludedObservedAt: 2_000 },
    }),
    v3Outcome(),
  ]);
  assert.strictEqual(lateFlow.joined[0].walletFlowDecision, null);
  assert.strictEqual(lateFlow.joined[0].excludedForLeakage, true);
  const ineligible = joinV3CollectorRows([
    v3Decision({
      walletFlow: { uniqueBuyers: 4, decisionEligible: false, lastIncludedObservedAt: 2_000 },
    }),
    v3Outcome(),
  ]);
  assert.strictEqual(ineligible.joined[0].walletFlowDecision, null);
  assert.strictEqual(ineligible.joined[0].excludedForLeakage, false);
  assert.strictEqual(ineligible.effective.length, 0);
});

test("after-cutoff curve is excluded and decision-eligible curve is kept", () => {
  const late = joinV3CollectorRows([
    v3Decision(),
    v3Outcome(),
    { type: "v3_curve", mint: "MintA", observedAt: 4_000, decisionEligible: false, curveProgress: 0.2 },
  ]);
  assert.strictEqual(late.joined[0].curveDecision, null);
  const markedLate = joinV3CollectorRows([
    v3Decision(),
    v3Outcome(),
    { type: "v3_curve", mint: "MintA", observedAt: 4_000, decisionEligible: true, curveProgress: 0.9 },
  ]);
  assert.strictEqual(markedLate.joined[0].curveDecision, null);
  assert.strictEqual(markedLate.joined[0].excludedForLeakage, true);
  const kept = joinV3CollectorRows([
    v3Decision(),
    v3Outcome(),
    { type: "v3_curve", mint: "MintA", observedAt: 900, decisionEligible: true, curveProgress: 0.1 },
  ]);
  assert.strictEqual(kept.joined[0].curveDecision.curveProgress, 0.1);
  assert.strictEqual(kept.summary.curveEligible, 1);
});

test("leakage and missing outcomes are excluded", () => {
  const leaked = joinV3CollectorRows([
    v3Decision({ leakageViolations: 2 }),
    v3Outcome(),
  ]);
  assert.strictEqual(leaked.effective.length, 0);
  assert.strictEqual(leaked.summary.leakageExcluded, 1);
  assert.strictEqual(leaked.joined[0].excludedForLeakage, true);
  const missing = joinV3CollectorRows([v3Decision()]);
  assert.strictEqual(missing.joined.length, 0);
  assert.strictEqual(missing.summary.exclusions.missing_outcome, 1);
});

test("missing MAE fails the opportunity pass gate", () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({
      id: "m" + i,
      researchEpoch: "selection_v3_shadow_2026_10",
      decisionCutoffAt: 10_000 + i,
      pnl: -1,
      mfe: null,
      mae: null,
      excludedForLeakage: false,
      walletFlowDecision: { uniqueBuyers: 1, decisionEligible: true, lastIncludedObservedAt: 10_000 + i },
    });
  }
  const gate = v3.judgeOpportunityPass(rows);
  assert.strictEqual(gate.researchVerdict, "FAIL_OPPORTUNITY_RESEARCH");
  assert.strictEqual(gate.reason, "MISSING_MAE_EVIDENCE");
  assert.strictEqual(gate.pass, false);
  const rep = v3.evaluateProgram({ riskRows: [], opportunityRows: rows });
  assert.notStrictEqual(rep.opportunity.researchVerdict, "PASS_OPPORTUNITY_RESEARCH");
  assert.strictEqual(rep.opportunity.status, "COLLECT_NEW_EPOCH");
});

test("duplicate outcomes are deduped deterministically", () => {
  const first = v3Outcome({ pnl: -1, mfe: 2, mae: -2 });
  const second = v3Outcome({ pnl: -9, mfe: 2, mae: -2 });
  const a = joinV3CollectorRows([v3Decision(), first, second]);
  const b = joinV3CollectorRows([v3Decision(), second, first]);
  assert.strictEqual(a.summary.exclusions.duplicate, 1);
  assert.strictEqual(a.joined.length, 1);
  assert.strictEqual(a.joined[0].pnl, b.joined[0].pnl);
});

test("collector rows are ordered by decisionCutoffAt and do not enter live_selected", () => {
  const joined = joinV3CollectorRows([
    v3Decision({ mint: "M2", createSignature: "S2", decisionCutoffAt: 3_000 }),
    v3Outcome({ mint: "M2", decisionCutoffAt: 3_000, pnl: -2 }),
    v3Decision({ mint: "M1", createSignature: "S1", decisionCutoffAt: 1_000 }),
    v3Outcome({ mint: "M1", decisionCutoffAt: 1_000, pnl: -1 }),
    v3Decision({ mint: "M3", createSignature: "S3", decisionCutoffAt: 2_000 }),
    v3Outcome({ mint: "M3", decisionCutoffAt: 2_000, pnl: -3 }),
  ]);
  assert.deepStrictEqual(joined.joined.map((r) => r.decisionCutoffAt), [1_000, 2_000, 3_000]);
  const live = filterEffective(
    joined.joined.map((r) => ({
      candidateId: r.id,
      mint: r.mint,
      researchEpoch: "post_fix_v1",
      selected: r.selected,
      sampleKind: r.sampleKind,
      convictionScore: 1,
      outcome: { status: "complete", complete: true, realizedPnl: r.pnl },
    })),
    { universe: "live_selected" }
  );
  assert.strictEqual(live.effective_n, 0);
  const folds = v3.walkForwardFolds(joined.effective.map((r) => ({ ...r, ts: r.decisionCutoffAt })));
  if (folds.length) {
    const maxTrain = Math.max(...folds[0].train.map((r) => r.ts));
    const minTest = Math.min(...folds[0].test.map((r) => r.ts));
    assert.ok(minTest >= maxTrain);
  }
});

test("opportunity evaluator uses collector rows and leaves historical risk unchanged", () => {
  const historical = [];
  for (let i = 0; i < 16; i++) {
    historical.push({
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
  const collector = joinV3CollectorRows([
    v3Decision({ mint: "MintZ", createSignature: "SigZ", decisionCutoffAt: 50 }),
    v3Outcome({ mint: "MintZ", decisionCutoffAt: 50 }),
  ]);
  const riskOnly = v3.evaluateProgram(historical);
  const split = v3.evaluateProgram({ riskRows: historical, opportunityRows: collector.joined });
  assert.strictEqual(split.risk.researchVerdict, riskOnly.risk.researchVerdict);
  assert.strictEqual(split.folds.length, riskOnly.folds.length);
  assert.strictEqual(split.opportunity.effectiveN, 1);
  assert.strictEqual(riskOnly.opportunity.effectiveN, 0);
  assert.strictEqual(split.opportunity.status, "COLLECT_NEW_EPOCH");
  assert.strictEqual(split.liveStatus, "UNCHANGED");
  assert.strictEqual(split.shadowCanPromoteLive, false);
  const text = formatV3Report({ ...split, collector: collector.summary }, null);
  assert.ok(text.includes("decisions: 1"));
  assert.ok(text.includes("V3_STATUS = COLLECT_NEW_EPOCH"));
  assert.ok(!text.includes("v3 rows="));
  assert.ok(!v3.FORBIDDEN_LIVE_TEXT.test(text));
  const loaderSrc = fs.readFileSync(path.join(__dirname, "v3-collector-loader.js"), "utf8");
  assert.ok(!/sendTransaction\s*\(/.test(loaderSrc));
  const ready = [];
  for (let i = 0; i < 100; i++) {
    ready.push({
      id: "e" + i,
      researchEpoch: "selection_v3_shadow_2026_10",
      decisionCutoffAt: 100_000 + i,
      ts: 100_000 + i,
      pnl: (i % 7) - 3,
      mfe: i % 5,
      mae: -1 - (i % 4),
      mayhem: false,
      excludedForLeakage: false,
      valuationSource: i % 2 === 0 ? "pump_curve" : "single_source",
      outcomeConfidence: i % 2 === 0 ? 0.6 : 0.4,
      walletFlowDecision: { uniqueBuyers: 1 + (i % 3), decisionEligible: true, lastIncludedObservedAt: 100_000 + i },
    });
  }
  const held = v3.evaluateProgram({ riskRows: historical, opportunityRows: ready });
  assert.strictEqual(held.opportunity.status, "HOLD_FOR_WALK_FORWARD");
  assert.strictEqual(held.opportunity.walkForwardEligible, true);
  assert.notStrictEqual(held.opportunity.researchVerdict, "PASS_OPPORTUNITY_RESEARCH");
  assert.strictEqual(held.risk.researchVerdict, riskOnly.risk.researchVerdict);
  assert.ok(held.opportunity.folds.length > 0);
  assert.ok(held.opportunity.folds[0].test ? true : held.opportunity.folds[0].n >= 0);
});

test("opportunity features read by family and constant flow cannot fit", () => {
  const row = {
    researchEpoch: "selection_v3_shadow_2026_10",
    decisionCutoffAt: 1_000,
    excludedForLeakage: false,
    sourceCountAtDecision: 2,
    walletFlowDecision: {
      uniqueBuyers: 1,
      buyVelocity: 4,
      topBuyerShare: 1,
      experiencedWalletCount: 0,
      sourceCount: 99,
      decisionEligible: true,
      lastIncludedObservedAt: 1_000,
    },
    curveDecision: { curveProgress: 0.25, decisionEligible: true, observedAt: 900 },
  };
  assert.strictEqual(v3.opportunityFeatureValue(row, { family: "walletFlow", name: "uniqueBuyers" }), 1);
  assert.strictEqual(v3.opportunityFeatureValue(row, { family: "walletFlow", name: "buyVelocity" }), 4);
  assert.strictEqual(v3.opportunityFeatureValue(row, { family: "listener", name: "sourceCount" }), 2);
  assert.notStrictEqual(v3.opportunityFeatureValue(row, { family: "listener", name: "sourceCount" }), 99);
  assert.strictEqual(v3.opportunityFeatureValue(row, { family: "curve", name: "curveProgress" }), 0.25);
  assert.strictEqual(v3.opportunityFeatureValue(row, { family: "walletFlow", name: "missingFeature" }), null);
  const lateFlow = {
    ...row,
    walletFlowDecision: { ...row.walletFlowDecision, lastIncludedObservedAt: 2_000 },
  };
  assert.strictEqual(v3.opportunityFeatureValue(lateFlow, { family: "walletFlow", name: "uniqueBuyers" }), null);
  const lateCurve = {
    ...row,
    curveDecision: { curveProgress: 0.9, decisionEligible: true, observedAt: 2_000 },
  };
  assert.strictEqual(v3.opportunityFeatureValue(lateCurve, { family: "curve", name: "curveProgress" }), null);
  const afterFlag = {
    ...row,
    curveDecision: { curveProgress: 0.4, decisionEligible: false, afterDecision: true, observedAt: 500 },
  };
  assert.strictEqual(v3.opportunityFeatureValue(afterFlag, { family: "curve", name: "curveProgress" }), null);

  const train = [];
  for (let i = 0; i < 40; i++) {
    train.push({
      researchEpoch: "selection_v3_shadow_2026_10",
      decisionCutoffAt: 5_000 + i,
      pnl: i % 2 === 0 ? -2 : 3,
      walletFlowDecision: {
        uniqueBuyers: 1,
        topBuyerShare: 1,
        decisionEligible: true,
        lastIncludedObservedAt: 5_000 + i,
      },
      sourceCountAtDecision: 1,
      curveDecision: null,
    });
  }
  const diag = v3.featureVariation(train);
  const buyers = diag.find((d) => d.feature === "walletFlow.uniqueBuyers");
  const share = diag.find((d) => d.feature === "walletFlow.topBuyerShare");
  const velocity = diag.find((d) => d.feature === "walletFlow.buyVelocity");
  assert.strictEqual(buyers.usable_for_fit, false);
  assert.strictEqual(buyers.unique_values, 1);
  assert.strictEqual(buyers.reason, "unique_values<2");
  assert.strictEqual(share.usable_for_fit, false);
  assert.strictEqual(velocity.coverage_n, 0);
  assert.strictEqual(velocity.usable_for_fit, false);
  const model = v3.fitOpportunity(train);
  assert.strictEqual(model.ready, false);
  assert.strictEqual(model.score(train[0]).opportunityScore, null);
  assert.strictEqual(model.score(train[0]).abstainReason, "no_feature_variation");
});

console.log("");
console.log("results: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
