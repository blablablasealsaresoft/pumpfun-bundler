#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const flow = require("./wallet-flow-v1");
const v3 = require("./selection-v3");
const { filterEffective } = require("./effective-n");
const { formatReport } = require("./wallet-flow-report");

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

function launch(book, partial) {
  flow.noteCandidate(book, {
    mint: "MintA",
    createSignature: "CreateSig",
    creator: "Creator",
    deployer: "Deployer",
    quoteMint: flow.SOL_MINT,
    observedAt: 1_000,
    ...partial,
  });
  flow.noteDecision(book, {
    mint: partial.mint || "MintA",
    createSignature: partial.createSignature || "CreateSig",
    creator: partial.creator || "Creator",
    deployer: partial.deployer || "Deployer",
    quoteMint: partial.quoteMint || flow.SOL_MINT,
    ts: partial.cutoff != null ? partial.cutoff : 1_200,
    mayhem: partial.mayhem === true,
    ret30s: partial.pnl,
    mfe30s: partial.mfe,
    mae30s: partial.mae,
    skipReason: partial.pnl != null ? "shadow|outcome" : "shadow",
    sourceCountAtDecision: partial.sourceCountAtDecision,
    deployerN: partial.deployerN,
  });
}

test("same tx from pre and processed dedupes once", () => {
  const book = flow.emptyBook();
  launch(book, {});
  const a = flow.observeFlow(book, { mint: "MintA", txSignature: "Tx1", wallet: "W1", side: "buy", quoteAmount: 0.4, observedAt: 1_100, source: "helius_preprocessed" });
  const b = flow.observeFlow(book, { mint: "MintA", txSignature: "Tx1", wallet: "W1", side: "buy", quoteAmount: 0.4, observedAt: 1_150, source: "helius_processed" });
  assert.strictEqual(a.accepted, true);
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(book.events.size, 1);
  assert.strictEqual(b.event.preObservedAt, 1_100);
  assert.strictEqual(b.event.processedObservedAt, 1_150);
  assert.strictEqual(b.event.observedAt, 1_100);
  const row = flow.buildRows(book)[0];
  assert.strictEqual(row.walletFlow500.buyCount, 1);
});

test("creator create-tx buy is excluded from independent buyers", () => {
  const book = flow.emptyBook();
  launch(book, {});
  flow.observeFlow(book, { mint: "MintA", txSignature: "CreateSig", wallet: "Creator", side: "buy", quoteAmount: 1, observedAt: 1_010, inCreateTransaction: true });
  const row = flow.buildRows(book)[0];
  assert.ok(row.createTxCreatorBuy);
  assert.strictEqual(row.walletFlow500.uniqueNonCreatorBuyers, 0);
  assert.strictEqual(row.walletFlow500.independentBuyerCount, 0);
});

test("post-create independent buy is counted", () => {
  const book = flow.emptyBook();
  launch(book, {});
  flow.observeFlow(book, { mint: "MintA", txSignature: "Tx2", wallet: "Other", side: "buy", quoteAmount: 0.5, observedAt: 1_100 });
  const row = flow.buildRows(book)[0];
  assert.strictEqual(row.walletFlow500.uniqueNonCreatorBuyers, 1);
  assert.strictEqual(row.walletFlow500.uniqueObservedBuyers, 1);
});

test("buy before cutoff is eligible and buy after cutoff is not", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 1_200 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "Early", wallet: "W1", side: "buy", quoteAmount: 0.2, observedAt: 1_100 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "Late", wallet: "W2", side: "buy", quoteAmount: 0.8, observedAt: 1_400 });
  const row = flow.buildRows(book)[0];
  assert.strictEqual(row.walletFlow500.decisionEligible, true);
  assert.strictEqual(row.walletFlow500.uniqueNonCreatorBuyers, 1);
  assert.strictEqual(row.walletFlow500.lastIncludedObservedAt, 1_100);
  assert.ok(row.walletFlow500.lastIncludedObservedAt <= row.decisionCutoffAt);
});

test("100 250 and 500 windows are independent", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "T100", wallet: "A", side: "buy", quoteAmount: 0.1, observedAt: 1_050 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "T250", wallet: "B", side: "buy", quoteAmount: 0.2, observedAt: 1_200 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "T500", wallet: "C", side: "buy", quoteAmount: 0.3, observedAt: 1_400 });
  const row = flow.buildRows(book)[0];
  assert.strictEqual(row.walletFlow100.uniqueNonCreatorBuyers, 1);
  assert.strictEqual(row.walletFlow250.uniqueNonCreatorBuyers, 2);
  assert.strictEqual(row.walletFlow500.uniqueNonCreatorBuyers, 3);
});

test("observation time controls eligibility, not chain block time", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 1_200 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "Chain", wallet: "W", side: "buy", quoteAmount: 1, observedAt: 1_500, chainTimeMs: 1_050 });
  const row = flow.buildRows(book)[0];
  assert.strictEqual(row.walletFlow500.uniqueNonCreatorBuyers, 0);
  assert.strictEqual(flow.featureValue(row, "walletFlow500.uniqueNonCreatorBuyers"), 0);
});

test("creator flow share, top share, and top3 share", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "C", wallet: "Creator", side: "buy", quoteAmount: 1, observedAt: 1_100, isCreator: true });
  flow.observeFlow(book, { mint: "MintA", txSignature: "A", wallet: "A", side: "buy", quoteAmount: 3, observedAt: 1_120 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "B", wallet: "B", side: "buy", quoteAmount: 1, observedAt: 1_140 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "D", wallet: "D", side: "buy", quoteAmount: 1, observedAt: 1_160 });
  const snap = flow.buildRows(book)[0].walletFlow500;
  assert.strictEqual(snap.creatorShareOfBuyFlow, 1 / 6);
  assert.ok(Math.abs(snap.topBuyerShare - 0.5) < 1e-9);
  assert.ok(Math.abs(snap.top3BuyerShare - 5 / 6) < 1e-9);
});

test("net flow, buy velocity, and unique-buyer velocity", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "B1", wallet: "A", side: "buy", quoteAmount: 2, observedAt: 1_100 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "S1", wallet: "A", side: "sell", quoteAmount: 0.5, observedAt: 1_150 });
  const snap = flow.buildRows(book)[0].walletFlow500;
  assert.strictEqual(snap.netBuySol, 1.5);
  assert.strictEqual(snap.buyVelocity, 1 / 0.5);
  assert.strictEqual(snap.uniqueBuyerVelocity, 1 / 0.5);
});

test("missing data stays null", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  const snap = flow.buildRows(book)[0].walletFlow250;
  assert.strictEqual(snap.firstIndependentBuyDelayMs, null);
  assert.strictEqual(snap.topBuyerShare, null);
  assert.strictEqual(snap.grossBuySol, null);
  assert.strictEqual(flow.featureValue({ walletFlow250: { decisionEligible: true, buyVelocity: null }, decisionCutoffAt: 1 }, "walletFlow250.buyVelocity"), null);
});

test("non-SOL quote is not labeled SOL", () => {
  const book = flow.emptyBook();
  launch(book, { quoteMint: flow.USDC_MINT, cutoff: 2_000 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "U", wallet: "W", side: "buy", quoteRaw: 2_000_000, quoteAmount: 2, observedAt: 1_100 });
  const snap = flow.buildRows(book)[0].walletFlow500;
  assert.strictEqual(snap.grossBuySol, null);
  assert.strictEqual(snap.quoteMint, flow.USDC_MINT);
  assert.ok(snap.grossBuyQuote > 0);
});

test("wallet history cannot use future launches", () => {
  const book = flow.emptyBook();
  launch(book, { mint: "Old", createSignature: "OldSig", cutoff: 1_000, pnl: 20, mfe: 20, mae: -1 });
  flow.noteDecision(book, { mint: "Old", ts: 1_500, skipReason: "shadow|outcome", ret30s: 20, mfe30s: 20, mae30s: -1 });
  flow.observeFlow(book, { mint: "Old", txSignature: "OldBuy", wallet: "Repeat", side: "buy", quoteAmount: 0.2, observedAt: 900 });
  launch(book, { mint: "New", createSignature: "NewSig", observedAt: 2_000, cutoff: 2_100, pnl: -1, mfe: 1, mae: -2 });
  flow.observeFlow(book, { mint: "New", txSignature: "NewBuy", wallet: "Repeat", side: "buy", quoteAmount: 0.2, observedAt: 2_050 });
  launch(book, { mint: "Mid", createSignature: "MidSig", observedAt: 1_200, cutoff: 1_250, pnl: -1, mfe: 0, mae: -1 });
  flow.observeFlow(book, { mint: "Mid", txSignature: "MidBuy", wallet: "Repeat", side: "buy", quoteAmount: 0.2, observedAt: 1_220 });
  const rows = flow.buildRows(book);
  const mid = rows.find((row) => row.mint === "Mid");
  const nxt = rows.find((row) => row.mint === "New");
  assert.strictEqual(mid.walletFlow500.experiencedWalletCount, 0);
  assert.strictEqual(nxt.walletFlow500.experiencedWalletCount, 1);
});

test("unresolved preprocessed wallet merges into the processed wallet", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  const pre = flow.observeFlow(book, { mint: "MintA", txSignature: "Same", wallet: null, side: "buy", quoteAmount: 0.4, observedAt: 1_100, source: "helius_preprocessed" });
  const processed = flow.observeFlow(book, { mint: "MintA", txSignature: "Same", wallet: "Known", side: "buy", quoteAmount: 0.4, observedAt: 1_140, source: "helius_processed" });
  assert.strictEqual(pre.accepted, true);
  assert.strictEqual(processed.duplicate, true);
  assert.strictEqual(book.events.size, 1);
  assert.strictEqual(processed.event.wallet, "Known");
  assert.strictEqual(flow.buildRows(book)[0].walletFlow500.buyCount, 1);
});

test("duplicate wallet transactions stay one buyer and two buys", () => {
  const book = flow.emptyBook();
  launch(book, { cutoff: 2_000 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "A", wallet: "W", side: "buy", quoteAmount: 0.2, observedAt: 1_100 });
  flow.observeFlow(book, { mint: "MintA", txSignature: "B", wallet: "W", side: "buy", quoteAmount: 0.3, observedAt: 1_180 });
  const snap = flow.buildRows(book)[0].walletFlow500;
  assert.strictEqual(snap.buyCount, 2);
  assert.strictEqual(snap.uniqueNonCreatorBuyers, 1);
});

test("train and test folds are temporally isolated", () => {
  const rows = [1, 2, 3, 4].map((i) => ({ id: "r" + i, decisionCutoffAt: i * 100, pnl: 1 }));
  const folds = flow.walkFolds(rows);
  assert.ok(folds.length >= 1);
  flow.assertTemporal(folds[0]);
  assert.throws(() => flow.assertTemporal({ train: [{ decisionCutoffAt: 500 }], test: [{ decisionCutoffAt: 100 }] }));
});

test("constant feature is rejected and low coverage is rejected", () => {
  const constant = [];
  for (let i = 0; i < 25; i++) {
    constant.push({ decisionCutoffAt: i, walletFlow250: { decisionEligible: true, uniqueNonCreatorBuyers: 1, lastIncludedObservedAt: i }, pnl: 1 });
  }
  const diag = flow.variationOf(constant, ["walletFlow250.uniqueNonCreatorBuyers"])[0];
  assert.strictEqual(diag.fit_eligible, false);
  assert.strictEqual(diag.unique_values, 1);
  assert.strictEqual(diag.reason, "unique_values<2");
  const sparse = [];
  for (let i = 0; i < 30; i++) sparse.push({ decisionCutoffAt: i, walletFlow250: { decisionEligible: true, lastIncludedObservedAt: i }, pnl: 1 });
  sparse[0].walletFlow250.grossBuySol = 1;
  const low = flow.variationOf(sparse, ["walletFlow250.grossBuySol"])[0];
  assert.strictEqual(low.fit_eligible, false);
  assert.strictEqual(low.reason, "coverage_too_low");
});

test("post-cutoff feature cannot enter the opportunity model", () => {
  const row = {
    decisionCutoffAt: 1_000,
    walletFlow250: { decisionEligible: false, uniqueNonCreatorBuyers: 4, lastIncludedObservedAt: 2_000, label: "DESCRIPTIVE_ONLY", notDecisionEligible: true },
    descriptive5000: { uniqueNonCreatorBuyers: 4, decisionEligible: false },
  };
  assert.strictEqual(flow.featureValue(row, "walletFlow250.uniqueNonCreatorBuyers"), null);
  const scored = flow.scoreModel([row, row], [row], ["walletFlow250.uniqueNonCreatorBuyers"]);
  assert.strictEqual(scored.abstainReason, "no_feature_variation");
});

test("mayhem stays out of the primary opportunity set", () => {
  const book = flow.emptyBook();
  launch(book, { mint: "Ok", pnl: -1, mfe: 1, mae: -2, mayhem: false });
  launch(book, { mint: "Hot", pnl: -30, mfe: 1, mae: -40, mayhem: true });
  const rep = flow.evaluateBook(book);
  assert.strictEqual(rep.mayhemN, 1);
  assert.strictEqual(rep.n, 1);
});

test("risk model live status is unchanged by wallet flow", () => {
  const rep = v3.evaluateProgram([]);
  assert.strictEqual(rep.liveStatus, "UNCHANGED");
  assert.strictEqual(rep.shadowCanPromoteLive, false);
  const src = fs.readFileSync(path.join(__dirname, "selection-v3.js"), "utf8");
  assert.ok(src.includes('name: "mayhem"'));
  assert.ok(!src.includes("wallet_flow_v1"));
});

test("shadow wallet flow cannot emit a live pass", () => {
  const book = flow.emptyBook();
  launch(book, { pnl: -1, mfe: 1, mae: -1 });
  const rep = flow.evaluateBook(book);
  assert.strictEqual(rep.pass, false);
  assert.strictEqual(rep.shadowCanPromoteLive, false);
  assert.notStrictEqual(rep.researchVerdict, "PASS_OPPORTUNITY_RESEARCH");
  const text = formatReport(rep);
  assert.ok(text.includes("UNCHANGED"));
  assert.ok(!/ENABLE LIVE|PROMOTE LIVE|TURN OFF KILL/.test(text));
  const live = filterEffective(
    [{ candidateId: "x", mint: "MintA", researchEpoch: "post_fix_v1", selected: false, sampleKind: "shadow", convictionScore: 1, outcome: { status: "complete", complete: true, realizedPnl: -1 } }],
    { universe: "live_selected" }
  );
  assert.strictEqual(live.effective_n, 0);
  assert.strictEqual(flow.strictPass({ folds: [{ abstainReason: null, n: 30, rhoPnl: 0.4, rhoMfe: 0.4, cohorts: { top5: { medianPnl: 1, runner10: 0.2, mfe: 2, mae: -1 }, baselineMedianPnl: -1 } }, { abstainReason: null, n: 30, rhoPnl: 0.4, rhoMfe: 0.4, cohorts: { top5: { medianPnl: 1, runner10: 0.2, mfe: 2, mae: -1 }, baselineMedianPnl: -1 } }] }).pass, false);
});

test("wallet flow modules do not submit transactions", () => {
  for (const file of ["wallet-flow-v1.js", "wallet-flow-collector.js", "wallet-flow-report.js", "wallet-flow-health.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(!/sendTransaction\s*\(/.test(src));
  }
  const listener = fs.readFileSync(path.join(__dirname, "..", "snipe-listener.ts"), "utf8");
  const buyAt = listener.indexOf("async function buyMint");
  const handleAt = listener.indexOf("async function handleCreate");
  const buyFn = listener.slice(buyAt, handleAt);
  assert.ok(!buyFn.includes("wallet-flow"));
  const killAt = listener.indexOf("expectancyKillSwitch();");
  const killWindow = listener.slice(killAt, killAt + 500);
  assert.ok(!killWindow.includes("wallet-flow"));
  assert.ok(listener.includes("wallet-flow-collector.js"));
  const infra = fs.readFileSync(path.join(__dirname, "..", "snipe-infra.ts"), "utf8");
  const decisionAt = infra.indexOf("export function logDecisionTrace");
  const nextFn = infra.indexOf("export {", decisionAt);
  const decisionFn = infra.slice(decisionAt, nextFn);
  assert.ok(decisionFn.includes("wallet-flow-collector.js"));
  assert.ok(!/sendTransaction\s*\(/.test(decisionFn));
});

test("trade log parser reads the pump trade event and ignores other data", () => {
  assert.strictEqual(flow.parseTradeEventLog("Program log: Instruction: Buy"), null);
  const { PublicKey } = require("@solana/web3.js");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const user = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const buf = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32);
  flow.TRADE_DISC.copy(buf, 0);
  mint.toBuffer().copy(buf, 8);
  buf.writeBigUInt64LE(500_000_000n, 40);
  buf.writeBigUInt64LE(1_000_000n, 48);
  buf[56] = 1;
  user.toBuffer().copy(buf, 57);
  const parsed = flow.parseTradeEventLog("Program data: " + buf.toString("base64"));
  assert.strictEqual(parsed.side, "buy");
  assert.strictEqual(parsed.wallet, user.toBase58());
  assert.strictEqual(parsed.mint, mint.toBase58());
});

test("buy instruction decoder does not invent a wallet", () => {
  const data = Buffer.alloc(24);
  data.write("66063d1201daebea", 0, "hex");
  data.writeBigUInt64LE(10n, 8);
  data.writeBigUInt64LE(2_000_000_000n, 16);
  const keys = ["g", "fee", "MintOnly"];
  const parsed = flow.flowFromBuyInstruction(keys, data, 1);
  assert.strictEqual(parsed.mint, "MintOnly");
  assert.strictEqual(parsed.wallet, null);
  assert.ok(parsed.eventConfidence < 0.7);
});

console.log("");
console.log("results: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
