"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Keypair, PublicKey } = require("@solana/web3.js");
const tf = require("./timing-frontier-v1");
const collector = require("./timing-frontier-collector");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok " + name);
}

function pk() {
  return Keypair.generate().publicKey.toBase58();
}

function writePubkey(buf, offset, value) {
  new PublicKey(value).toBuffer().copy(buf, offset);
}

function tradeEvent(fields) {
  const buf = Buffer.alloc(225);
  tf.TRADE_DISC.copy(buf, 0);
  writePubkey(buf, 8, fields.mint);
  buf.writeBigUInt64LE(BigInt(fields.solAmountRaw), 40);
  buf.writeBigUInt64LE(BigInt(fields.tokenAmountRaw), 48);
  buf[56] = fields.isBuy === false ? 0 : 1;
  writePubkey(buf, 57, fields.user);
  buf.writeBigInt64LE(BigInt(fields.timestamp || 0), 89);
  buf.writeBigUInt64LE(BigInt(fields.virtualSolReservesRaw), 97);
  buf.writeBigUInt64LE(BigInt(fields.virtualTokenReservesRaw), 105);
  buf.writeBigUInt64LE(BigInt(fields.realSolReservesRaw), 113);
  buf.writeBigUInt64LE(BigInt(fields.realTokenReservesRaw), 121);
  writePubkey(buf, 129, fields.feeRecipient || fields.user);
  buf.writeBigUInt64LE(BigInt(fields.feeBasisPoints), 161);
  buf.writeBigUInt64LE(BigInt(fields.feeRaw), 169);
  writePubkey(buf, 177, fields.creator);
  buf.writeBigUInt64LE(BigInt(fields.creatorFeeBasisPoints), 209);
  buf.writeBigUInt64LE(BigInt(fields.creatorFeeRaw), 217);
  return buf;
}

function borshString(text) {
  const body = Buffer.from(text, "utf8");
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function createEvent(fields) {
  const parts = [
    tf.CREATE_DISC,
    borshString(fields.name || "n"),
    borshString(fields.symbol || "s"),
    borshString(fields.uri || "u"),
  ];
  const tail = Buffer.alloc(32 * 4 + 8 + 8 * 4 + 32 + 1 + 1 + 32);
  let o = 0;
  writePubkey(tail, o, fields.mint); o += 32;
  writePubkey(tail, o, fields.bondingCurve || fields.mint); o += 32;
  writePubkey(tail, o, fields.user); o += 32;
  writePubkey(tail, o, fields.creator); o += 32;
  tail.writeBigInt64LE(BigInt(fields.timestamp || 0), o); o += 8;
  tail.writeBigUInt64LE(BigInt(fields.virtualTokenReservesRaw), o); o += 8;
  tail.writeBigUInt64LE(BigInt(fields.virtualSolReservesRaw), o); o += 8;
  tail.writeBigUInt64LE(BigInt(fields.realTokenReservesRaw), o); o += 8;
  tail.writeBigUInt64LE(BigInt(fields.supply || 1), o); o += 8;
  writePubkey(tail, o, fields.tokenProgram || fields.user); o += 32;
  tail[o] = fields.mayhem ? 1 : 0; o += 1;
  tail[o] = 0; o += 1;
  writePubkey(tail, o, fields.quoteMint || tf.SOL_MINT);
  return Buffer.concat(parts.concat([tail]));
}

function baseTrade(over) {
  return {
    solAmountRaw: "100000000",
    tokenAmountRaw: "1000",
    virtualSolReservesRaw: "31000000000",
    virtualTokenReservesRaw: "1000000000000",
    realSolReservesRaw: "1000000000",
    realTokenReservesRaw: "700000000000",
    feeBasisPoints: "100",
    feeRaw: "1000",
    creatorFeeBasisPoints: "30",
    creatorFeeRaw: "300",
    isBuy: true,
    ...over,
  };
}

test("complete TradeEvent parsing keeps every published field", () => {
  const mint = pk();
  const user = pk();
  const creator = pk();
  const parsed = tf.parseTradeEvent(tradeEvent(baseTrade({
    mint, user, creator, solAmountRaw: "123", tokenAmountRaw: "456", isBuy: false,
  })));
  assert.equal(parsed.type, "pump_trade_state_v1");
  assert.equal(parsed.mint, mint);
  assert.equal(parsed.user, user);
  assert.equal(parsed.creator, creator);
  assert.equal(parsed.isBuy, false);
  assert.equal(parsed.solAmountRaw, "123");
  assert.equal(parsed.tokenAmountRaw, "456");
  assert.equal(parsed.featureVersion, "timing_frontier_v1");
});

test("u64 values above the safe integer range stay decimal strings", () => {
  const unsafe = "9007199254740993";
  const parsed = tf.parseTradeEvent(tradeEvent(baseTrade({
    mint: pk(), user: pk(), creator: pk(), virtualTokenReservesRaw: unsafe,
  })));
  assert.equal(parsed.virtualTokenReservesRaw, unsafe);
  assert.notEqual(String(Number(unsafe)), unsafe);
});

test("virtual and real reserves and both fee fields parse exactly", () => {
  const parsed = tf.parseTradeEvent(tradeEvent(baseTrade({
    mint: pk(),
    user: pk(),
    creator: pk(),
    virtualSolReservesRaw: "30000000001",
    virtualTokenReservesRaw: "1073000000000001",
    realSolReservesRaw: "42",
    realTokenReservesRaw: "43",
    feeBasisPoints: "95",
    feeRaw: "111",
    creatorFeeBasisPoints: "25",
    creatorFeeRaw: "222",
  })));
  assert.equal(parsed.virtualSolReservesRaw, "30000000001");
  assert.equal(parsed.virtualTokenReservesRaw, "1073000000000001");
  assert.equal(parsed.realSolReservesRaw, "42");
  assert.equal(parsed.realTokenReservesRaw, "43");
  assert.equal(parsed.feeBasisPoints, 95);
  assert.equal(parsed.feeRaw, "111");
  assert.equal(parsed.creatorFeeBasisPoints, 25);
  assert.equal(parsed.creatorFeeRaw, "222");
});

test("CreateEvent initial state keeps explicit reserves and does not invent a fee", () => {
  const mint = pk();
  const parsed = tf.parseCreateEvent(createEvent({
    mint,
    user: pk(),
    creator: pk(),
    virtualTokenReservesRaw: "999",
    virtualSolReservesRaw: "123456789",
    realTokenReservesRaw: "800",
    mayhem: false,
  }));
  assert.equal(parsed.confident, true);
  assert.equal(parsed.virtualSolReservesRaw, "123456789");
  assert.equal(parsed.virtualTokenReservesRaw, "999");
  assert.equal(parsed.realTokenReservesRaw, "800");
  assert.equal(parsed.realSolReservesRaw, "0");
  assert.equal(parsed.realSolReservesSource, "protocol_initial_omitted_from_create_event");
  assert.equal(parsed.creatorFeeBasisPoints, null);
  assert.notEqual(parsed.virtualSolReservesRaw, "30000000000");
  assert.equal(tf.parseCreateEvent(Buffer.from([1, 2, 3])), null);
});

test("last known reserve state stops at the horizon", () => {
  const book = tf.emptyBook();
  const mint = pk();
  const first = 5_000_000;
  tf.observeCreate(book, {
    mint,
    txSignature: "create",
    observedAt: first,
    creator: pk(),
    user: pk(),
    virtualTokenReservesRaw: "1000",
    virtualSolReservesRaw: "1000",
    realTokenReservesRaw: "1000",
    realSolReservesRaw: "0",
    quoteMint: tf.SOL_MINT,
    confident: true,
    feeBasisPoints: 100,
    creatorFeeBasisPoints: 0,
  });
  tf.observeCutoff(book, { mint, decisionCutoffAt: first + 80, createSig: "create" });
  const early = baseTrade({ mint, user: pk(), creator: pk(), virtualSolReservesRaw: "111" });
  const late = baseTrade({ mint, user: pk(), creator: pk(), virtualSolReservesRaw: "999" });
  tf.observeTrade(book, { ...tf.parseTradeEvent(tradeEvent(early)), txSignature: "early", observedAt: first + 40, source: "processed_logs" });
  tf.observeTrade(book, { ...tf.parseTradeEvent(tradeEvent(late)), txSignature: "late", observedAt: first + 400, source: "processed_logs" });
  const picked = tf.stateAt(book.launches.get(mint), first + 100);
  assert.equal(picked.state.txSignature, "early");
  assert.equal(picked.state.virtualSolReservesRaw, "111");
  const features = tf.snapshotFeatures(book.launches.get(mint), "100");
  assert.equal(features.horizonEnd, first + 100);
});

test("observations after the horizon are excluded from the snapshot", () => {
  const book = tf.emptyBook();
  const mint = pk();
  const creator = pk();
  const first = 8_000_000;
  tf.observeCreate(book, {
    mint, txSignature: "c", observedAt: first, creator, user: creator,
    virtualTokenReservesRaw: "1000", virtualSolReservesRaw: "1000",
    realTokenReservesRaw: "1000", realSolReservesRaw: "0",
    quoteMint: tf.SOL_MINT, confident: true, feeBasisPoints: 100, creatorFeeBasisPoints: 0,
  });
  const buyer = pk();
  const early = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: buyer, creator })));
  const lateBuyer = pk();
  const late = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: lateBuyer, creator, solAmountRaw: "9000000000" })));
  tf.observeTrade(book, { ...early, txSignature: "e", observedAt: first + 20, source: "processed_logs" });
  tf.observeTrade(book, { ...late, txSignature: "l", observedAt: first + 900, source: "processed_logs" });
  book.launches.get(mint)._book = book;
  const snap = tf.snapshotFeatures(book.launches.get(mint), "100");
  assert.equal(snap.uniqueNonCreatorBuyers, 1);
  assert.ok(snap.grossBuySol < 1);
});

test("exact curve buy is not the spot-price ratio", () => {
  const state = {
    virtualSolReservesRaw: "30000000000",
    virtualTokenReservesRaw: "1073000000000000",
    realSolReservesRaw: "0",
    realTokenReservesRaw: "793100000000000",
    feeBasisPoints: 100,
    creatorFeeBasisPoints: 30,
  };
  const quoted = tf.quotePumpBuy(state, tf.RESEARCH_BUY_LAMPORTS);
  assert.equal(quoted.spendLamports, "49383000");
  const spend = tf.RESEARCH_BUY_LAMPORTS;
  const total = 130n;
  let net = (spend * 10000n) / (10000n + total);
  const protocolFee = (net * 100n + 9999n) / 10000n;
  const creatorFee = (net * 30n + 9999n) / 10000n;
  if (net + protocolFee + creatorFee > spend) net = net - (net + protocolFee + creatorFee - spend);
  const tokens = ((net - 1n) * 1073000000000000n) / (30000000000n + net - 1n);
  assert.equal(quoted.tokensOutRaw, tokens.toString());
  const spotTokens = (spend * 1073000000000000n) / 30000000000n;
  assert.notEqual(quoted.tokensOutRaw, spotTokens.toString());
  assert.equal(tf.quotePumpBuy({ ...state, feeBasisPoints: null, creatorFeeBasisPoints: null }), null);
});

test("entry premium is measured against the current-cutoff quote", () => {
  const book = filledBook({ laterSol: "80000000000" });
  const launch = [...book.launches.values()][0];
  launch._book = book;
  const current = tf.entryAt(launch, "current");
  const later = tf.entryAt(launch, "500");
  assert.ok(BigInt(current.entry.tokensOutRaw) > BigInt(later.entry.tokensOutRaw));
  const rows = tf.buildHorizonRows(book, "500", { nonMayhem: true });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].entryPremiumPct > 0);
});

test("post-entry pnl uses only states after the hypothetical entry", () => {
  const book = filledBook({ laterSol: "20000000000", markSol: "25000000000" });
  const launch = [...book.launches.values()][0];
  const outcome = tf.outcomeAt(launch, "100");
  assert.equal(outcome.abstain, null);
  assert.equal(typeof outcome.pnl, "number");
  const pre = launch.trades.find((t) => t.txSignature === "preHigh");
  const prePnl = tf.pnlPct
    ? null
    : null;
  void prePnl;
  const sold = tf.quotePumpSell(pre, BigInt(outcome.entry.tokensOutRaw));
  const spend = tf.RESEARCH_BUY_LAMPORTS;
  const prePct = Number((sold - spend) * 10000n / spend) / 100;
  assert.notEqual(outcome.mfe, prePct);
  assert.ok(outcome.mfe < prePct);
});

test("MFE ignores a pre-entry high and MAE ignores a pre-entry low", () => {
  const book = filledBook({ laterSol: "32000000000", markSol: "33000000000", dipSol: "34000000000" });
  const launch = [...book.launches.values()][0];
  const outcome = tf.outcomeAt(launch, "100");
  const preHigh = launch.trades.find((t) => t.txSignature === "preHigh");
  const preLow = launch.trades.find((t) => t.txSignature === "preLow");
  const tokens = BigInt(outcome.entry.tokensOutRaw);
  const high = Number((tf.quotePumpSell(preHigh, tokens) - tf.RESEARCH_BUY_LAMPORTS) * 10000n / tf.RESEARCH_BUY_LAMPORTS) / 100;
  const low = Number((tf.quotePumpSell(preLow, tokens) - tf.RESEARCH_BUY_LAMPORTS) * 10000n / tf.RESEARCH_BUY_LAMPORTS) / 100;
  assert.ok(high > outcome.mfe);
  assert.ok(low < outcome.mae);
  assert.ok(outcome.mfe >= outcome.pnl);
  assert.ok(outcome.mae <= outcome.pnl);
});

test("an incomplete executed path abstains from timing economics", () => {
  const book = tf.emptyBook();
  const mint = pk();
  tf.observeCreate(book, {
    mint, txSignature: "c", observedAt: 10, creator: pk(), user: pk(),
    virtualTokenReservesRaw: "1000", virtualSolReservesRaw: "1000",
    realTokenReservesRaw: "1000", realSolReservesRaw: "0",
    quoteMint: tf.SOL_MINT, confident: true, feeBasisPoints: 100, creatorFeeBasisPoints: 0,
  });
  assert.equal(tf.pathComplete(book.launches.get(mint), 2000), false);
  assert.equal(tf.buildHorizonRows(book, "100", { nonMayhem: true }).length, 0);
  const health = tf.healthFromBook(book);
  assert.equal(health.launchesWithComplete2sPath, 0);
  assert.equal(health.leakage, 0);
});

test("a custom quote is not labeled as SOL", () => {
  const book = filledBook({ quoteMint: tf.USDC_MINT });
  const launch = [...book.launches.values()][0];
  const entry = tf.entryAt(launch, "100");
  assert.equal(entry.abstain, "custom_quote");
  launch._book = book;
  const snap = tf.snapshotFeatures(launch, "100");
  assert.equal(snap.grossBuySol, null);
  assert.equal(snap.quoteMint, tf.USDC_MINT);
  assert.notEqual(snap.quoteMint, tf.SOL_MINT);
});

test("mayhem launches stay out of the primary sample", () => {
  const book = filledBook({ mayhem: true });
  assert.equal(tf.buildHorizonRows(book, "100", { nonMayhem: true }).length, 0);
  assert.equal(tf.buildHorizonRows(book, "100", { mayhemOnly: true }).length, 1);
});

test("walk-forward folds stay in temporal order", () => {
  const rows = [];
  for (let i = 0; i < 16; i++) {
    rows.push({
      features: {
        uniqueNonCreatorBuyers: i,
        grossBuySol: i / 10,
        netBuySol: i / 10,
        buyVelocity: i,
        uniqueBuyerVelocity: i,
        topBuyerShare: 0.2,
        creatorShareOfBuyFlow: 0,
        firstIndependentBuyDelayMs: 10,
      },
      pnl: i,
      mfe: i,
      mae: -1,
      decisionCutoffAt: 1000 + i,
      firstObservedAt: 1000 + i,
    });
  }
  const walk = tf.walkForward(rows, ["uniqueNonCreatorBuyers"]);
  assert.ok(walk.folds.length >= 2);
  assert.ok(walk.folds.every((fold) => fold.temporal === true));
});

test("correlation without the economics gates does not pass", () => {
  const fold = {
    rhoPnl: 0.8,
    rhoMfe: 0.8,
    ordered: false,
    topMedianPnl: -5,
    baselineMedianPnl: -1,
    topRunner10: 0,
    baselineRunner10: 0.1,
    topMfe: 1,
    baselineMfe: 2,
    topMae: -20,
    baselineMae: -5,
    bootstrapSupport: false,
    permutationBeatsNull: false,
    tailDependent: true,
    temporal: true,
  };
  const result = tf.strictResearchPass({ folds: [fold, fold] });
  assert.equal(result.pass, false);
  assert.equal(result.livePromotion, false);
  assert.equal(result.reason, "correlation_alone_is_not_a_pass");
});

test("timing research cannot promote live", () => {
  const book = filledBook({});
  const result = tf.evaluateBook(book);
  assert.equal(result.shadowCanPromoteLive, false);
  assert.equal(result.pass, false);
  assert.equal(result.liveStatus, "UNCHANGED");
  assert.equal(result.liveTrading, "OFF");
  assert.equal(result.kill, "ON");
  assert.equal(result.verdict, "INSUFFICIENT_EXECUTED_STATE_COVERAGE");
  tf.assertNoLivePromotion(JSON.stringify(result));
});

test("research files do not send transactions or move the live cutoff", () => {
  const root = path.join(__dirname, "..");
  const files = [
    "research/timing-frontier-v1.js",
    "research/timing-frontier-collector.js",
    "research/timing-frontier-health.js",
    "research/timing-frontier-report.js",
    "snipe-listener.ts",
    "snipe-infra.ts",
  ];
  for (const file of files.slice(0, 4)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(/\bsendTransaction\s*\(/.test(text), false);
    assert.equal(/\bsendRawTransaction\s*\(/.test(text), false);
  }
  const listener = fs.readFileSync(path.join(root, "snipe-listener.ts"), "utf8");
  const start = listener.indexOf("function startTimingStateLane");
  const end = listener.indexOf("async function main");
  assert.ok(start > 0 && end > start);
  const lane = listener.slice(start, end);
  assert.equal(lane.includes("handleCreate"), false);
  assert.equal(lane.includes("sendTransaction"), false);
  assert.equal(lane.includes("sendRawTransaction"), false);
  assert.equal(lane.includes("BUY_SOL"), false);
  assert.equal(lane.includes("decisionCutoff"), false);
  assert.ok(listener.includes("const BUY_SOL"));
  const infra = fs.readFileSync(path.join(root, "snipe-infra.ts"), "utf8");
  assert.equal(/\bt\.ts\s*=/.test(infra), false);
  assert.equal(/\bt\.decisionCutoffAt\s*=/.test(infra), false);
});

test("collector appends executed state without becoming a sender", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timing-"));
  collector.setTracePath(path.join(dir, "timing.jsonl"));
  collector.resetForTests();
  const mint = pk();
  const user = pk();
  const creator = pk();
  const raw = tradeEvent(baseTrade({ mint, user, creator }));
  const logs = ["Program data: " + raw.toString("base64")];
  collector.noteLogs({ logs, txSignature: "sig1", observedAt: 50, slot: 7, source: "processed_logs" });
  collector.noteLogs({ logs, txSignature: "sig1", observedAt: 55, slot: 7, source: "processed_logs" });
  const book = collector.getBook();
  assert.equal(book.trades.size, 1);
  assert.equal(book.duplicateMerges, 1);
  const trade = book.trades.get("sig1|" + mint);
  assert.equal(trade.virtualSolReservesRaw, "31000000000");
  assert.equal(trade.observedAt, 50);
  const text = fs.readFileSync(path.join(dir, "timing.jsonl"), "utf8");
  assert.equal(/\bsendTransaction\s*\(/.test(text), false);
  collector.setTracePath(null);
  collector.resetForTests();
});

test("frozen Fomo target CSV matches the predeclared Solana universe", () => {
  const fomo = require("./fomo-target-set");
  const set = fomo.loadTargetSet();
  assert.equal(set.loaded, true);
  assert.equal(set.matchesExpected, true);
  assert.equal(set.version, "fomoscan_wallets_2026_09_16_v1");
  assert.equal(set.snapshotAt, "2026-09-16T21:50:00Z");
  assert.equal(set.counts.f0, 355);
  assert.equal(set.counts.f1, 144);
  assert.equal(set.counts.f2, 52);
  assert.equal(set.counts.f3, 46);
  assert.equal(set.counts.f4, 20);
  assert.equal(set.counts.f5, 9);
  assert.equal(set.observedSwaps, 20619);
});

test("companion zero-swap Fomo-app wallet is not treated as chain-observed", () => {
  const fomo = require("./fomo-target-set");
  const set = fomo.loadTargetSet();
  // cryptomocro: observed solana vs companion embedded solana with swaps=0
  const observed = set.byAddress.get("8fuFGqDcr2nj1Athn1at1kCBc34w1SWQHVZJWXTWZgdL");
  const companion = set.byAddress.get("WYtYh4q94ekR9NmVzpATCpp4WfMwHbnepo1ZwzcNCtJ");
  assert.ok(observed);
  assert.ok(companion);
  assert.equal(observed.fomoClaimedWallet, true);
  assert.equal(observed.chainObservedFomoWallet, true);
  assert.equal(companion.fomoClaimedWallet, true);
  assert.equal(companion.chainObservedFomoWallet, false);
  assert.equal(companion.priorObservedSwapCount, 0);
  assert.equal(observed.traderId, companion.traderId);
});

test("Fomo features stay null before the external snapshot and use trader_id for clusters", () => {
  const fomo = require("./fomo-target-set");
  const set = fomo.loadTargetSet();
  const observedAddr = "8fuFGqDcr2nj1Athn1at1kCBc34w1SWQHVZJWXTWZgdL";
  const companionAddr = "WYtYh4q94ekR9NmVzpATCpp4WfMwHbnepo1ZwzcNCtJ";
  const other = [...set.byAddress.values()].find(
    (w) => w.chainObservedFomoWallet && w.traderId !== set.byAddress.get(observedAddr).traderId
  );
  assert.ok(other);
  const book = tf.emptyBook();
  const mint = pk();
  const creator = pk();
  const first = Date.parse("2026-09-10T00:00:00Z");
  tf.observeCreate(book, {
    mint, txSignature: "c", observedAt: first, creator, user: creator,
    virtualTokenReservesRaw: "1000", virtualSolReservesRaw: "1000",
    realTokenReservesRaw: "1000", realSolReservesRaw: "0",
    quoteMint: tf.SOL_MINT, confident: true, feeBasisPoints: 100, creatorFeeBasisPoints: 0,
  });
  const early = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: observedAddr, creator })));
  tf.observeTrade(book, { ...early, txSignature: "b1", observedAt: first + 20, source: "processed_logs" });
  book.launches.get(mint)._book = book;
  const before = tf.snapshotFeatures(book.launches.get(mint), "100", { targetSet: set });
  assert.equal(before.externalTargetFeatureEligible, false);
  assert.equal(before.f1BuyerCount, null);

  const afterFirst = Date.parse("2026-09-17T00:00:00Z");
  const book2 = tf.emptyBook();
  tf.observeCreate(book2, {
    mint, txSignature: "c2", observedAt: afterFirst, creator, user: creator,
    virtualTokenReservesRaw: "1000", virtualSolReservesRaw: "1000",
    realTokenReservesRaw: "1000", realSolReservesRaw: "0",
    quoteMint: tf.SOL_MINT, confident: true, feeBasisPoints: 100, creatorFeeBasisPoints: 0,
  });
  const t1 = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: observedAddr, creator })));
  const t2 = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: companionAddr, creator })));
  const t3 = tf.parseTradeEvent(tradeEvent(baseTrade({ mint, user: other.address, creator })));
  tf.observeTrade(book2, { ...t1, txSignature: "a", observedAt: afterFirst + 10, source: "processed_logs" });
  tf.observeTrade(book2, { ...t2, txSignature: "b", observedAt: afterFirst + 20, source: "processed_logs" });
  tf.observeTrade(book2, { ...t3, txSignature: "c3", observedAt: afterFirst + 30, source: "processed_logs" });
  book2.launches.get(mint)._book = book2;
  const snap = tf.snapshotFeatures(book2.launches.get(mint), "100", { targetSet: set });
  assert.equal(snap.externalTargetFeatureEligible, true);
  assert.equal(snap.f0BuyerCount, 3);
  assert.equal(snap.f1BuyerCount, 2);
  assert.equal(snap.f1Cluster2, 1);
  assert.equal(snap.distinctObservedFomoTraderCount, 2);
  assert.ok(typeof snap.firstF1BuyerDelayMs === "number");
});

test("T5 models cannot promote live", () => {
  const result = tf.evaluateBook(tf.emptyBook());
  for (const name of ["T5a", "T5b", "T5c", "T5d", "T5e", "T5f"]) {
    assert.ok(result.models[name]);
    assert.equal(result.models[name].livePromotion, false);
  }
  assert.equal(result.fomoTargetStudyCannotPromoteLive, true);
  assert.equal(result.shadowCanPromoteLive, false);
});

function filledBook(opts) {
  const book = tf.emptyBook();
  const mint = pk();
  const creator = pk();
  const first = 1_000_000;
  const quoteMint = opts.quoteMint || tf.SOL_MINT;
  tf.observeCreate(book, {
    mint,
    txSignature: "createSig",
    observedAt: first,
    creator,
    user: creator,
    virtualTokenReservesRaw: "1073000000000000",
    virtualSolReservesRaw: "30000000000",
    realTokenReservesRaw: "793100000000000",
    realSolReservesRaw: "0",
    quoteMint,
    mayhem: opts.mayhem === true,
    confident: true,
    feeBasisPoints: 100,
    creatorFeeBasisPoints: 30,
  });
  tf.observeCutoff(book, {
    mint,
    decisionCutoffAt: first + 80,
    createSig: "createSig",
    creator,
    mayhem: opts.mayhem === true,
    quoteMint,
  });
  const buyer = pk();
  const rows = [
    ["preLow", first + 10, "5000000000", buyer],
    ["preHigh", first + 20, "90000000000", buyer],
    ["early", first + 40, "31000000000", buyer],
    ["later", first + 400, opts.laterSol || "50000000000", pk()],
    ["mark", first + 2100, opts.markSol || "36000000000", pk()],
    ["dip", first + 2300, opts.dipSol || "37000000000", pk()],
  ];
  for (const [sig, at, sol, user] of rows) {
    const parsed = tf.parseTradeEvent(tradeEvent(baseTrade({
      mint, user, creator, virtualSolReservesRaw: sol, quoteMint,
    })));
    tf.observeTrade(book, {
      ...parsed,
      txSignature: sig,
      observedAt: at,
      source: "processed_logs",
      quoteMint,
    });
  }
  book.launches.get(mint)._book = book;
  return book;
}

console.log(passed + " timing-frontier tests passed");
