/**
 * Information-versus-entry-price timing frontier. Research only.
 *
 * Frozen before results. Do not add or remove horizons after seeing outcomes
 * without marking that analysis exploratory.
 *
 * Horizons, relative to canonical first local observation:
 *   current cutoff, 100, 250, 500, 750, 1000, 1500, 2000 ms
 *
 * Question: does information gained between roughly 100ms and 2s improve
 * forward outcomes enough to overcome the worse executable entry from waiting?
 *
 * This module does not submit transactions, move the live cutoff, or change
 * a live gate. Shadow output cannot promote live.
 */
"use strict";

const { PublicKey } = require("@solana/web3.js");
const { mean, pctile, trimmedMean, spearman, bootstrapMedianDiff, mulberry32 } = require("./math");

const FEATURE_VERSION = "timing_frontier_v1";
const EVENT_TYPE = "pump_trade_state_v1";
const RESEARCH_EPOCH = "selection_timing_frontier_2026_10";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const RESEARCH_BUY_SOL = "0.049383";
const RESEARCH_BUY_LAMPORTS = 49383000n;
const HORIZON_MS = [100, 250, 500, 750, 1000, 1500, 2000];
const HORIZONS = ["current", ...HORIZON_MS.map(String)];
const MIN_EFFECTIVE_N = 100;
const COVERAGE_MIN_N = 20;
const COVERAGE_MIN_PCT = 0.2;
const COMPLETE_2S_MS = 2000;
const COMPLETE_30S_MS = 30000;

const TRADE_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const COMPLETE_DISC = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);
const MIGRATION_DISC = Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]);

const O1_FEATURES = [
  "uniqueNonCreatorBuyers",
  "grossBuySol",
  "netBuySol",
  "buyVelocity",
  "uniqueBuyerVelocity",
  "topBuyerShare",
  "creatorShareOfBuyFlow",
  "firstIndependentBuyDelayMs",
];

const MODELS = {
  T0: ["uniqueNonCreatorBuyers", "independentBuyCount", "buyVelocity", "uniqueBuyerVelocity"],
  T1: ["grossBuySol", "netBuySol", "topBuyerShare", "top3BuyerShare"],
  T2: ["experiencedWalletCount"],
  T3: [
    "uniqueNonCreatorBuyers",
    "independentBuyCount",
    "buyVelocity",
    "uniqueBuyerVelocity",
    "experiencedWalletCount",
  ],
  T4: [
    "uniqueNonCreatorBuyers",
    "independentBuyCount",
    "buyVelocity",
    "uniqueBuyerVelocity",
    "experiencedWalletCount",
    "sourceCount",
  ],
};

const FORBIDDEN_LIVE_TEXT = ["ENABLE LIVE", "PROMOTE LIVE", "TURN OFF KILL"];

function emptyBook() {
  return {
    launches: new Map(),
    trades: new Map(),
    duplicateMerges: 0,
    tradeObservations: 0,
    executedTradeStates: 0,
    leakage: 0,
  };
}

function launchOf(book, mint) {
  let row = book.launches.get(mint);
  if (!row) {
    row = {
      mint,
      featureVersion: FEATURE_VERSION,
      create: null,
      cutoff: null,
      trades: [],
      sources: [],
      curveCompletedAt: null,
      migrationObservedAt: null,
      venueAfterMigration: null,
      mayhem: null,
    };
    book.launches.set(mint, row);
  }
  return row;
}

function b58(buf) {
  return new PublicKey(buf).toBase58();
}

function u64(buf, offset) {
  return buf.readBigUInt64LE(offset).toString();
}

function readBorshString(buf, offset) {
  if (offset + 4 > buf.length) throw new Error("string OOB");
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) throw new Error("string OOB");
  return [buf.slice(start, end).toString("utf8"), end];
}

function feeNumber(raw) {
  if (raw == null) return null;
  const v = BigInt(raw);
  if (v < 0n || v > 100000n) return null;
  return Number(v);
}

function normalizeQuote(quoteMint) {
  if (!quoteMint || quoteMint === DEFAULT_PUBKEY) return SOL_MINT;
  return quoteMint;
}

function quoteIsSol(quoteMint) {
  const q = normalizeQuote(quoteMint);
  return q === SOL_MINT;
}

/**
 * Full TradeEvent. Prefix matches the local IDL layout.
 * Fee and creator fields are read only when those bytes are present.
 * Every u64 is returned as a decimal string. Nothing is cast through Number.
 */
function parseTradeEvent(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 129 || !raw.slice(0, 8).equals(TRADE_DISC)) {
    return null;
  }
  let o = 8;
  const mint = b58(raw.slice(o, o + 32));
  o += 32;
  const solAmountRaw = u64(raw, o);
  o += 8;
  const tokenAmountRaw = u64(raw, o);
  o += 8;
  const isBuy = raw[o] !== 0;
  o += 1;
  const user = b58(raw.slice(o, o + 32));
  o += 32;
  o += 8; // chain timestamp retained nowhere as eligibility
  const virtualSolReservesRaw = u64(raw, o);
  o += 8;
  const virtualTokenReservesRaw = u64(raw, o);
  o += 8;
  const realSolReservesRaw = u64(raw, o);
  o += 8;
  const realTokenReservesRaw = u64(raw, o);
  o += 8;
  let feeBasisPoints = null;
  let feeRaw = null;
  let creator = null;
  let creatorFeeBasisPoints = null;
  let creatorFeeRaw = null;
  if (raw.length >= o + 32 + 8 + 8 + 32 + 8 + 8) {
    o += 32; // fee recipient
    const feeBpsRaw = u64(raw, o);
    o += 8;
    feeRaw = u64(raw, o);
    o += 8;
    creator = b58(raw.slice(o, o + 32));
    o += 32;
    const creatorBpsRaw = u64(raw, o);
    o += 8;
    creatorFeeRaw = u64(raw, o);
    feeBasisPoints = feeNumber(feeBpsRaw);
    creatorFeeBasisPoints = feeNumber(creatorBpsRaw);
  }
  return {
    type: EVENT_TYPE,
    mint,
    user,
    isBuy,
    solAmountRaw,
    tokenAmountRaw,
    virtualSolReservesRaw,
    virtualTokenReservesRaw,
    realSolReservesRaw,
    realTokenReservesRaw,
    feeBasisPoints,
    feeRaw,
    creator,
    creatorFeeBasisPoints,
    creatorFeeRaw,
    quoteMint: null,
    featureVersion: FEATURE_VERSION,
  };
}

function parseCreateEvent(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 8 || !raw.slice(0, 8).equals(CREATE_DISC)) return null;
  try {
    let o = 8;
    [, o] = readBorshString(raw, o);
    [, o] = readBorshString(raw, o);
    [, o] = readBorshString(raw, o);
    const mint = b58(raw.slice(o, o + 32));
    o += 32;
    o += 32; // bonding curve
    const user = b58(raw.slice(o, o + 32));
    o += 32;
    const creator = b58(raw.slice(o, o + 32));
    o += 32;
    o += 8; // chain timestamp, not eligibility
    const virtualTokenReservesRaw = u64(raw, o);
    o += 8;
    const virtualSolReservesRaw = u64(raw, o);
    o += 8;
    const realTokenReservesRaw = u64(raw, o);
    o += 8;
    o += 8; // token total supply; real quote reserves are not in this layout
    if (o + 32 + 1 + 1 + 32 > raw.length) return null;
    o += 32; // token program
    const mayhem = raw[o] !== 0;
    o += 1;
    o += 1; // cashback
    const quoteMint = normalizeQuote(b58(raw.slice(o, o + 32)));
    if (BigInt(virtualTokenReservesRaw) <= 0n || BigInt(virtualSolReservesRaw) <= 0n) return null;
    if (BigInt(realTokenReservesRaw) <= 0n) return null;
    return {
      mint,
      user,
      creator,
      virtualTokenReservesRaw,
      virtualSolReservesRaw,
      realTokenReservesRaw,
      // Protocol sets initial real quote reserves to 0. The CreateEvent layout
      // omits the field. This is not a guessed virtual-reserve default.
      realSolReservesRaw: "0",
      realSolReservesSource: "protocol_initial_omitted_from_create_event",
      quoteMint,
      mayhem,
      creatorFeeBasisPoints: null,
      confident: true,
    };
  } catch {
    return null;
  }
}

function parseCompleteEvent(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 8 + 32 + 32 + 32 + 8 || !raw.slice(0, 8).equals(COMPLETE_DISC)) {
    return null;
  }
  return { mint: b58(raw.slice(8 + 32, 8 + 64)) };
}

function parseMigrationEvent(raw, knownMints) {
  if (!Buffer.isBuffer(raw) || raw.length < 8 + 32 || !raw.slice(0, 8).equals(MIGRATION_DISC)) return null;
  const candidates = [];
  if (raw.length >= 8 + 32) candidates.push(b58(raw.slice(8, 40)));
  if (raw.length >= 8 + 64) candidates.push(b58(raw.slice(40, 72)));
  const mint = candidates.find((m) => knownMints.has(m));
  return mint ? { mint, venue: "pumpswap" } : null;
}

function programDataBuffers(logs) {
  const out = [];
  for (const line of logs || []) {
    if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
    try {
      out.push(Buffer.from(line.slice("Program data: ".length), "base64"));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function firstObservedAt(launch) {
  const times = [];
  if (launch.create && Number.isFinite(launch.create.observedAt)) times.push(launch.create.observedAt);
  const createSig = launch.create && launch.create.txSignature;
  if (createSig) {
    for (const src of launch.sources) {
      if (src.txSignature === createSig && Number.isFinite(src.observedAt)) times.push(src.observedAt);
    }
  }
  if (!times.length) return null;
  return Math.min(...times);
}

function horizonEnd(launch, horizon) {
  const first = firstObservedAt(launch);
  if (first == null) return null;
  if (horizon === "current") {
    if (!launch.cutoff || !Number.isFinite(launch.cutoff.decisionCutoffAt)) return null;
    return launch.cutoff.decisionCutoffAt;
  }
  const ms = Number(horizon);
  if (!Number.isFinite(ms)) return null;
  return first + ms;
}

function reservesOf(state) {
  if (!state) return null;
  try {
    const virtualSol = BigInt(state.virtualSolReservesRaw);
    const virtualToken = BigInt(state.virtualTokenReservesRaw);
    const realSol = BigInt(state.realSolReservesRaw);
    const realToken = BigInt(state.realTokenReservesRaw);
    if (virtualSol <= 0n || virtualToken <= 0n || realToken < 0n || realSol < 0n) return null;
    return { virtualSol, virtualToken, realSol, realToken };
  } catch {
    return null;
  }
}

function stateAt(launch, end) {
  if (end == null) return null;
  let best = null;
  for (const trade of launch.trades) {
    if (!Number.isFinite(trade.observedAt) || trade.observedAt > end) continue;
    if (!reservesOf(trade)) continue;
    if (!best || trade.observedAt > best.observedAt || (trade.observedAt === best.observedAt && trade.txSignature > best.txSignature)) {
      best = trade;
    }
  }
  if (best) return { kind: "trade", state: best };
  if (launch.create && launch.create.confident && reservesOf(launch.create)) {
    return { kind: "create", state: launch.create };
  }
  return null;
}

function lamportsToSol(raw) {
  try {
    const v = BigInt(raw);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v) / 1e9;
  } catch {
    return null;
  }
}

function snapshotFeatures(launch, horizon) {
  const end = horizonEnd(launch, horizon);
  const first = firstObservedAt(launch);
  if (end == null || first == null) return null;
  const quoteMint = launch.create ? launch.create.quoteMint : null;
  const solQuote = quoteIsSol(quoteMint);
  const creator = (launch.create && launch.create.creator) || (launch.cutoff && launch.cutoff.creator) || null;
  const deployer = (launch.cutoff && launch.cutoff.deployer) || (launch.create && launch.create.user) || null;
  const createSig = (launch.create && launch.create.txSignature) || (launch.cutoff && launch.cutoff.createSig) || null;
  const buys = new Map();
  let independentBuyCount = 0;
  let sellCount = 0;
  let grossBuy = 0n;
  let grossSell = 0n;
  let creatorBuy = 0n;
  let nonCreatorBuy = 0n;
  const delays = [];
  const sources = new Set();
  for (const trade of launch.trades) {
    if (!Number.isFinite(trade.observedAt) || trade.observedAt > end) continue;
    if (trade.source) sources.add(trade.source);
    const inCreate = createSig && trade.txSignature === createSig;
    const isCreator = creator && trade.user === creator;
    const isDeployer = deployer && trade.user === deployer;
    if (trade.isBuy) {
      const amt = trade.solAmountRaw ? BigInt(trade.solAmountRaw) : 0n;
      if (solQuote) grossBuy += amt;
      if (isCreator) creatorBuy += amt;
      if (!inCreate && trade.user && !isCreator && !isDeployer) {
        independentBuyCount += 1;
        nonCreatorBuy += amt;
        delays.push(trade.observedAt - first);
        const prev = buys.get(trade.user) || 0n;
        buys.set(trade.user, prev + amt);
      }
    } else {
      sellCount += 1;
      if (solQuote && trade.solAmountRaw) grossSell += BigInt(trade.solAmountRaw);
    }
  }
  for (const src of launch.sources) {
    if (Number.isFinite(src.observedAt) && src.observedAt <= end && src.source) sources.add(src.source);
  }
  const amounts = [...buys.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = amounts.reduce((a, b) => a + b, 0n);
  const share = (n) => (total > 0n ? Number((amounts.slice(0, n).reduce((a, b) => a + b, 0n) * 10000n) / total) / 10000 : null);
  const windowSec = Math.max((end - first) / 1000, 0.001);
  const experienced = experiencedWalletCount(launch, end, buys);
  const grossBuySol = solQuote ? lamportsToSol(grossBuy) : null;
  const grossSellSol = solQuote ? lamportsToSol(grossSell) : null;
  const netBuySol = grossBuySol != null && grossSellSol != null ? grossBuySol - grossSellSol : null;
  const creatorShare = solQuote && grossBuy > 0n ? Number((creatorBuy * 10000n) / grossBuy) / 10000 : null;
  return {
    horizon,
    horizonEnd: end,
    uniqueNonCreatorBuyers: buys.size,
    independentBuyCount,
    sellCount,
    grossBuySol,
    grossSellSol,
    netBuySol,
    grossBuyQuoteRaw: grossBuy.toString(),
    quoteMint: quoteMint || null,
    buyerConcentration: share(1),
    topBuyerShare: share(1),
    top3BuyerShare: share(Math.min(3, amounts.length)),
    uniqueBuyerVelocity: buys.size / windowSec,
    buyVelocity: independentBuyCount / windowSec,
    experiencedWalletCount: experienced,
    firstIndependentBuyDelayMs: delays.length ? Math.min(...delays) : null,
    secondIndependentBuyDelayMs: delays.length > 1 ? [...delays].sort((a, b) => a - b)[1] : null,
    creatorParticipation: creatorBuy > 0n ? 1 : 0,
    creatorShareOfBuyFlow: creatorShare,
    sourceCount: sources.size,
    solQuote,
  };
}

function experiencedWalletCount(launch, end, buyers) {
  if (!buyers.size) return 0;
  return countExperienced(launch, end, buyers);
}

function countExperienced(launch, end, buyers) {
  const book = launch._book;
  if (!book) return null;
  const known = new Set();
  for (const other of book.launches.values()) {
    if (other.mint === launch.mint) continue;
    const otherFirst = firstObservedAt(other);
    if (otherFirst == null || otherFirst >= end) continue;
    for (const trade of other.trades) {
      if (!trade.isBuy || !trade.user) continue;
      if (!Number.isFinite(trade.observedAt) || trade.observedAt >= end) continue;
      known.add(trade.user);
    }
  }
  let n = 0;
  for (const wallet of buyers.keys()) if (known.has(wallet)) n += 1;
  return n;
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * Pump buyExactSolIn integer quote.
 * Fees come from the state that published them. Missing fees abstain.
 * tokens_out = floor((net_sol - 1) * virtual_token / (virtual_sol + net_sol - 1))
 */
function quotePumpBuy(state, spendLamports = RESEARCH_BUY_LAMPORTS) {
  const reserves = reservesOf(state);
  if (!reserves) return null;
  if (state.feeBasisPoints == null || state.creatorFeeBasisPoints == null) return null;
  const protocolBps = BigInt(state.feeBasisPoints);
  const creatorBps = BigInt(state.creatorFeeBasisPoints);
  const totalBps = protocolBps + creatorBps;
  if (totalBps < 0n || spendLamports <= 0n) return null;
  let net = (spendLamports * 10000n) / (10000n + totalBps);
  const protocolFee = ceilDiv(net * protocolBps, 10000n);
  const creatorFee = ceilDiv(net * creatorBps, 10000n);
  if (net + protocolFee + creatorFee > spendLamports) {
    net = net - (net + protocolFee + creatorFee - spendLamports);
  }
  if (net <= 1n) return null;
  const tokensOut = ((net - 1n) * reserves.virtualToken) / (reserves.virtualSol + net - 1n);
  if (tokensOut <= 0n) return null;
  const spotNum = reserves.virtualSol;
  const spotDen = reserves.virtualToken;
  const effectiveNum = spendLamports;
  const effectiveDen = tokensOut;
  let priceImpactPct = null;
  if (spotNum > 0n) {
    const impact = (effectiveNum * spotDen * 10000n) / (effectiveDen * spotNum) - 10000n;
    if (impact <= BigInt(Number.MAX_SAFE_INTEGER) && impact >= BigInt(-Number.MAX_SAFE_INTEGER)) {
      priceImpactPct = Number(impact) / 100;
    }
  }
  return {
    spendLamports: spendLamports.toString(),
    tokensOutRaw: tokensOut.toString(),
    protocolFeeRaw: protocolFee.toString(),
    creatorFeeRaw: creatorFee.toString(),
    allInEntryCostRaw: spendLamports.toString(),
    spotPriceLamportsPerToken: spotDen > 0n ? ratio(spotNum, spotDen) : null,
    effectiveEntryPriceLamportsPerToken: ratio(effectiveNum, effectiveDen),
    priceImpactPct,
    netSolRaw: net.toString(),
  };
}

function ratio(num, den) {
  if (den <= 0n) return null;
  const scale = 1000000000000n;
  const scaled = (num * scale) / den;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled) / 1e12;
}

function quotePumpSell(state, tokenIn) {
  const reserves = reservesOf(state);
  if (!reserves || tokenIn <= 0n) return null;
  if (state.feeBasisPoints == null || state.creatorFeeBasisPoints == null) return null;
  const gross = (tokenIn * reserves.virtualSol) / (reserves.virtualToken + tokenIn);
  const protocolFee = ceilDiv(gross * BigInt(state.feeBasisPoints), 10000n);
  const creatorFee = ceilDiv(gross * BigInt(state.creatorFeeBasisPoints), 10000n);
  const solOut = gross - protocolFee - creatorFee;
  if (solOut < 0n) return null;
  return solOut;
}

function quotePumpSwap(pool) {
  if (!pool) return null;
  try {
    const base = BigInt(pool.baseReservesRaw);
    const quote = BigInt(pool.quoteReservesRaw);
    const spend = pool.spendLamports != null ? BigInt(pool.spendLamports) : RESEARCH_BUY_LAMPORTS;
    if (base <= 0n || quote < 0n || spend <= 0n) return null;
    const out = (spend * base) / (quote + spend);
    return { tokensOutRaw: out.toString(), adapter: "pumpswap_reserves" };
  } catch {
    return null;
  }
}

function quoteRaydiumAmountOut(pool) {
  const quoted = quotePumpSwap(pool);
  if (!quoted) return null;
  return { ...quoted, adapter: "raydium_compute_amount_out" };
}

function observeJupiterRoute(route) {
  if (!route || route.observedOnly !== true) return null;
  return {
    adapter: "jupiter_route_cost",
    inLamports: route.inLamports != null ? String(route.inLamports) : null,
    outAmountRaw: route.outAmountRaw != null ? String(route.outAmountRaw) : null,
    sent: false,
  };
}

function pnlPct(solOut, spend) {
  const delta = (solOut - spend) * 10000n / spend;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < BigInt(-Number.MAX_SAFE_INTEGER)) return null;
  return Number(delta) / 100;
}

function entryAt(launch, horizon) {
  const end = horizonEnd(launch, horizon);
  const picked = stateAt(launch, end);
  if (!picked) return null;
  const quoteMint = (picked.state.quoteMint || (launch.create && launch.create.quoteMint) || null);
  if (!quoteIsSol(quoteMint)) {
    return { abstain: "custom_quote", quoteMint, horizon, entry: null };
  }
  const entry = quotePumpBuy(picked.state);
  if (!entry) return { abstain: "no_authoritative_quote", horizon, entry: null, stateKind: picked.kind };
  return { abstain: null, horizon, entry, stateKind: picked.kind, observedAt: picked.state.observedAt || end, quoteMint };
}

function postEntryMarks(launch, horizon, tokensOut) {
  const end = horizonEnd(launch, horizon);
  if (end == null) return [];
  const marks = [];
  for (const trade of launch.trades) {
    if (!Number.isFinite(trade.observedAt) || trade.observedAt <= end) continue;
    if (!quoteIsSol(trade.quoteMint || (launch.create && launch.create.quoteMint))) continue;
    const solOut = quotePumpSell(trade, tokensOut);
    if (solOut == null) continue;
    const pnl = pnlPct(solOut, RESEARCH_BUY_LAMPORTS);
    if (pnl == null) continue;
    marks.push({ observedAt: trade.observedAt, pnl });
  }
  return marks;
}

function outcomeAt(launch, horizon) {
  const quoted = entryAt(launch, horizon);
  if (!quoted || quoted.abstain || !quoted.entry) {
    return { horizon, abstain: quoted ? quoted.abstain : "no_state", pnl: null, mfe: null, mae: null, entry: null };
  }
  const marks = postEntryMarks(launch, horizon, BigInt(quoted.entry.tokensOutRaw));
  if (!marks.length) {
    return { horizon, abstain: "no_post_entry_state", pnl: null, mfe: null, mae: null, entry: quoted.entry, stateKind: quoted.stateKind };
  }
  marks.sort((a, b) => a.observedAt - b.observedAt);
  const last = marks[marks.length - 1];
  const pnls = marks.map((m) => m.pnl);
  return {
    horizon,
    abstain: null,
    pnl: last.pnl,
    mfe: Math.max(...pnls),
    mae: Math.min(...pnls),
    entry: quoted.entry,
    stateKind: quoted.stateKind,
    marks: marks.length,
  };
}

function pathComplete(launch, ms) {
  const first = firstObservedAt(launch);
  if (!launch.create || !launch.create.confident || first == null) return false;
  if (!launch.trades.some((t) => reservesOf(t))) return false;
  const last = Math.max(...launch.trades.map((t) => t.observedAt).filter((t) => Number.isFinite(t)));
  return last >= first + ms;
}

function observeCreate(book, input) {
  if (!input || !input.mint) return null;
  const launch = launchOf(book, input.mint);
  launch._book = book;
  const create = {
    mint: input.mint,
    txSignature: input.txSignature || null,
    observedAt: input.observedAt,
    slot: input.slot == null ? null : input.slot,
    source: input.source || null,
    user: input.user || null,
    creator: input.creator || null,
    virtualTokenReservesRaw: input.virtualTokenReservesRaw,
    virtualSolReservesRaw: input.virtualSolReservesRaw,
    realTokenReservesRaw: input.realTokenReservesRaw,
    realSolReservesRaw: input.realSolReservesRaw,
    realSolReservesSource: input.realSolReservesSource || null,
    quoteMint: input.quoteMint ? normalizeQuote(input.quoteMint) : null,
    mayhem: input.mayhem === true,
    creatorFeeBasisPoints: input.creatorFeeBasisPoints == null ? null : input.creatorFeeBasisPoints,
    feeBasisPoints: input.feeBasisPoints == null ? null : input.feeBasisPoints,
    confident: input.confident === true && reservesOf(input) != null,
    featureVersion: FEATURE_VERSION,
  };
  if (!launch.create) launch.create = create;
  else if (create.confident && !launch.create.confident) launch.create = create;
  launch.mayhem = launch.create.mayhem === true;
  return launch.create;
}

function observeTrade(book, input) {
  if (!input || !input.mint || !input.txSignature) return null;
  book.tradeObservations += 1;
  const key = input.txSignature + "|" + input.mint;
  const launch = launchOf(book, input.mint);
  launch._book = book;
  const prev = book.trades.get(key);
  if (prev) {
    book.duplicateMerges += 1;
    if (input.observedAt < prev.observedAt) prev.observedAt = input.observedAt;
    if (input.source && input.source !== prev.source) {
      prev.sources = prev.sources || [prev.source];
      if (!prev.sources.includes(input.source)) prev.sources.push(input.source);
    }
    for (const field of [
      "solAmountRaw",
      "tokenAmountRaw",
      "virtualSolReservesRaw",
      "virtualTokenReservesRaw",
      "realSolReservesRaw",
      "realTokenReservesRaw",
      "feeRaw",
      "creatorFeeRaw",
      "user",
      "creator",
    ]) {
      if (prev[field] == null && input[field] != null) prev[field] = input[field];
    }
    if (prev.feeBasisPoints == null && input.feeBasisPoints != null) prev.feeBasisPoints = input.feeBasisPoints;
    if (prev.creatorFeeBasisPoints == null && input.creatorFeeBasisPoints != null) {
      prev.creatorFeeBasisPoints = input.creatorFeeBasisPoints;
    }
    if (!prev.quoteMint && input.quoteMint) prev.quoteMint = normalizeQuote(input.quoteMint);
    return prev;
  }
  const row = {
    type: EVENT_TYPE,
    mint: input.mint,
    txSignature: input.txSignature,
    observedAt: input.observedAt,
    slot: input.slot == null ? null : input.slot,
    source: input.source || null,
    sources: input.source ? [input.source] : [],
    user: input.user || null,
    isBuy: input.isBuy === true,
    solAmountRaw: input.solAmountRaw || null,
    tokenAmountRaw: input.tokenAmountRaw || null,
    virtualSolReservesRaw: input.virtualSolReservesRaw || null,
    virtualTokenReservesRaw: input.virtualTokenReservesRaw || null,
    realSolReservesRaw: input.realSolReservesRaw || null,
    realTokenReservesRaw: input.realTokenReservesRaw || null,
    feeBasisPoints: input.feeBasisPoints == null ? null : input.feeBasisPoints,
    feeRaw: input.feeRaw || null,
    creator: input.creator || null,
    creatorFeeBasisPoints: input.creatorFeeBasisPoints == null ? null : input.creatorFeeBasisPoints,
    creatorFeeRaw: input.creatorFeeRaw || null,
    quoteMint: input.quoteMint ? normalizeQuote(input.quoteMint) : null,
    featureVersion: input.featureVersion || FEATURE_VERSION,
  };
  if (row.featureVersion !== FEATURE_VERSION) return null;
  book.trades.set(key, row);
  launch.trades.push(row);
  if (reservesOf(row)) book.executedTradeStates += 1;
  if (launch.create && launch.create.quoteMint && !row.quoteMint) row.quoteMint = launch.create.quoteMint;
  return row;
}

function observeCutoff(book, input) {
  if (!input || !input.mint || !Number.isFinite(input.decisionCutoffAt)) return null;
  const launch = launchOf(book, input.mint);
  launch._book = book;
  if (!launch.cutoff) {
    launch.cutoff = {
      decisionCutoffAt: input.decisionCutoffAt,
      creator: input.creator || null,
      deployer: input.deployer || null,
      createSig: input.createSig || null,
      mayhem: input.mayhem === true,
      quoteMint: input.quoteMint ? normalizeQuote(input.quoteMint) : null,
    };
  }
  if (launch.mayhem == null) launch.mayhem = input.mayhem === true;
  return launch.cutoff;
}

function observeSource(book, input) {
  if (!input || !input.txSignature || !Number.isFinite(input.observedAt)) return null;
  const row = {
    txSignature: input.txSignature,
    mint: input.mint || null,
    source: input.source || null,
    observedAt: input.observedAt,
    slot: input.slot == null ? null : input.slot,
  };
  if (row.mint) launchOf(book, row.mint).sources.push(row);
  else {
    for (const launch of book.launches.values()) {
      const sig = (launch.create && launch.create.txSignature) || (launch.cutoff && launch.cutoff.createSig);
      if (sig && sig === row.txSignature) launch.sources.push(row);
    }
  }
  return row;
}

function observeMigration(book, input) {
  if (!input || !input.mint || !Number.isFinite(input.observedAt)) return null;
  const launch = launchOf(book, input.mint);
  if (input.kind === "complete" && launch.curveCompletedAt == null) launch.curveCompletedAt = input.observedAt;
  if (input.kind === "migration") {
    if (launch.migrationObservedAt == null) launch.migrationObservedAt = input.observedAt;
    launch.venueAfterMigration = input.venue || launch.venueAfterMigration;
  }
  return launch;
}

function noteLogs(book, input) {
  const bufs = programDataBuffers(input.logs);
  const known = new Set(book.launches.keys());
  for (const raw of bufs) {
    const trade = parseTradeEvent(raw);
    if (trade) {
      observeTrade(book, {
        ...trade,
        txSignature: input.txSignature,
        observedAt: input.observedAt,
        slot: input.slot,
        source: input.source || "processed_logs",
      });
      continue;
    }
    const create = parseCreateEvent(raw);
    if (create) {
      observeCreate(book, {
        ...create,
        txSignature: input.txSignature,
        observedAt: input.observedAt,
        slot: input.slot,
        source: input.source || "processed_logs",
      });
      continue;
    }
    const complete = parseCompleteEvent(raw);
    if (complete) {
      observeMigration(book, { mint: complete.mint, observedAt: input.observedAt, kind: "complete" });
      continue;
    }
    const migration = parseMigrationEvent(raw, known);
    if (migration) {
      observeMigration(book, {
        mint: migration.mint,
        observedAt: input.observedAt,
        kind: "migration",
        venue: migration.venue,
      });
    }
  }
}

function coverage(rows, field) {
  const vals = rows.map((r) => r.features[field]).filter((v) => typeof v === "number" && Number.isFinite(v));
  const n = rows.length;
  const uniq = new Set(vals.map((v) => String(v))).size;
  const mu = mean(vals);
  const variance = vals.length ? mean(vals.map((v) => (v - mu) * (v - mu))) : 0;
  const std = Math.sqrt(variance || 0);
  let eligible = true;
  let reason = null;
  if (n === 0 || vals.length < COVERAGE_MIN_N || vals.length / n < COVERAGE_MIN_PCT) {
    eligible = false;
    reason = "coverage";
  } else if (uniq < 2) {
    eligible = false;
    reason = "unique_values";
  } else if (std < 1e-12) {
    eligible = false;
    reason = "stddev";
  }
  return { field, n: vals.length, coverage: n ? vals.length / n : 0, unique: uniq, std, eligible, reason };
}

function buildHorizonRows(book, horizon, opts = {}) {
  const rows = [];
  for (const launch of book.launches.values()) {
    launch._book = book;
    if (launch.featureVersion && launch.featureVersion !== FEATURE_VERSION) continue;
    if (!pathComplete(launch, COMPLETE_2S_MS)) continue;
    if (opts.nonMayhem && launch.mayhem === true) continue;
    if (opts.mayhemOnly && launch.mayhem !== true) continue;
    const features = snapshotFeatures(launch, horizon);
    if (!features) continue;
    const outcome = outcomeAt(launch, horizon);
    const current = horizon === "current" ? outcome : outcomeAt(launch, "current");
    let entryPremiumPct = null;
    if (outcome.entry && current.entry) {
      const tokensH = BigInt(outcome.entry.tokensOutRaw);
      const tokensC = BigInt(current.entry.tokensOutRaw);
      if (tokensH > 0n && tokensC > 0n) {
        const premium = (tokensC - tokensH) * 10000n / tokensC;
        if (premium <= BigInt(Number.MAX_SAFE_INTEGER) && premium >= BigInt(-Number.MAX_SAFE_INTEGER)) {
          entryPremiumPct = Number(premium) / 100;
        }
      }
    }
    rows.push({
      mint: launch.mint,
      firstObservedAt: firstObservedAt(launch),
      decisionCutoffAt: launch.cutoff ? launch.cutoff.decisionCutoffAt : null,
      mayhem: launch.mayhem === true,
      features,
      outcome,
      entryPremiumPct,
      pnl: outcome.pnl,
      mfe: outcome.mfe,
      mae: outcome.mae,
    });
  }
  rows.sort((a, b) => (a.decisionCutoffAt || a.firstObservedAt || 0) - (b.decisionCutoffAt || b.firstObservedAt || 0));
  return rows;
}

function featureVector(row, names) {
  return names.map((n) => row.features[n]);
}

function scoreModel(train, test, names) {
  const weights = [];
  for (const name of names) {
    const rho = spearman(train.map((r) => r.features[name]), train.map((r) => r.pnl)).rho;
    if (rho == null || rho === 0) continue;
    weights.push({ name, rho });
  }
  if (!weights.length) return test.map(() => null);
  return test.map((row) => {
    let s = 0;
    let used = 0;
    for (const w of weights) {
      const v = row.features[w.name];
      if (typeof v !== "number") continue;
      s += w.rho * v;
      used += 1;
    }
    return used ? s : null;
  });
}

function cohortStats(rows) {
  const pnls = rows.map((r) => r.pnl).filter((v) => typeof v === "number");
  const mfes = rows.map((r) => r.mfe).filter((v) => typeof v === "number");
  const maes = rows.map((r) => r.mae).filter((v) => typeof v === "number");
  return {
    n: rows.length,
    medianPnl: pctile(pnls, 50),
    trimmedPnl: trimmedMean(pnls, 0.1),
    runner10: pnls.length ? pnls.filter((p) => p >= 10).length / pnls.length : null,
    mfe: pctile(mfes, 50),
    mae: pctile(maes, 50),
    catastrophic: pnls.length ? pnls.filter((p) => p <= -50).length / pnls.length : null,
  };
}

function walkForward(rows, names) {
  const usable = rows.filter((r) => typeof r.pnl === "number" && typeof r.mfe === "number" && typeof r.mae === "number");
  if (usable.length < 12) {
    return { folds: [], reason: "too_few_rows", pass: false };
  }
  const chunks = 4;
  const size = Math.floor(usable.length / chunks);
  if (size < 3) return { folds: [], reason: "too_few_rows", pass: false };
  const folds = [];
  for (let i = 1; i < chunks; i++) {
    const train = usable.slice(0, i * size);
    const test = usable.slice(i * size, (i + 1) * size);
    const trainMax = Math.max(...train.map((r) => r.decisionCutoffAt || r.firstObservedAt || 0));
    const testMin = Math.min(...test.map((r) => r.decisionCutoffAt || r.firstObservedAt || 0));
    if (!(testMin >= trainMax)) {
      folds.push({ pass: false, reason: "temporal_order" });
      continue;
    }
    const scores = scoreModel(train, test, names);
    const paired = test.map((row, idx) => ({ ...row, score: scores[idx] })).filter((r) => typeof r.score === "number");
    paired.sort((a, b) => b.score - a.score);
    const topN = Math.max(1, Math.ceil(paired.length * 0.2));
    const top = paired.slice(0, topN);
    const rhoPnl = spearman(paired.map((r) => r.score), paired.map((r) => r.pnl));
    const rhoMfe = spearman(paired.map((r) => r.score), paired.map((r) => r.mfe));
    const base = cohortStats(paired);
    const topStats = cohortStats(top);
    const ordered = top.length >= 2 && paired.every((r, idx) => idx === 0 || paired[idx - 1].score >= r.score);
    const support = foldSupport(paired, top);
    folds.push({
      n: paired.length,
      rhoPnl: rhoPnl.rho,
      rhoMfe: rhoMfe.rho,
      topMedianPnl: topStats.medianPnl,
      baselineMedianPnl: base.medianPnl,
      topRunner10: topStats.runner10,
      baselineRunner10: base.runner10,
      topMfe: topStats.mfe,
      baselineMfe: base.mfe,
      topMae: topStats.mae,
      baselineMae: base.mae,
      ordered,
      temporal: testMin >= trainMax,
      bootstrapSupport: support.bootstrapSupport,
      permutationBeatsNull: support.permutationBeatsNull,
      tailDependent: support.tailDependent,
    });
  }
  return { folds, pass: false, reason: "correlation_alone_is_not_a_pass" };
}

function foldSupport(paired, top) {
  const boot = bootstrapMedianDiff(
    top.map((r) => r.pnl),
    paired.map((r) => r.pnl),
    { nBoot: 80, seed: 7 }
  );
  const bootstrapSupport = boot.lo != null && boot.lo > 0;
  const scores = paired.map((r) => r.score);
  const pnls = paired.map((r) => r.pnl);
  const observed = spearman(scores, pnls).rho;
  let beats = 0;
  const rng = mulberry32(9);
  const trials = 40;
  for (let t = 0; t < trials; t++) {
    const shuffled = pnls.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const rho = spearman(scores, shuffled).rho;
    if (rho != null && observed != null && Math.abs(rho) >= Math.abs(observed) - 1e-12) beats += 1;
  }
  const sorted = paired.slice().sort((a, b) => b.pnl - a.pnl);
  const drop = Math.max(1, Math.floor(sorted.length * 0.05));
  const kept = sorted.slice(drop);
  const tail = spearman(kept.map((r) => r.score), kept.map((r) => r.pnl)).rho;
  const tailDependent = tail != null && observed != null && Math.sign(tail) !== 0 && Math.sign(tail) !== Math.sign(observed);
  return {
    bootstrapSupport,
    permutationBeatsNull: observed != null && beats / trials <= 0.1,
    tailDependent,
  };
}

function strictResearchPass(walk) {
  if (!walk || !walk.folds || walk.folds.length < 2) {
    return { pass: false, livePromotion: false, reason: walk && walk.reason ? walk.reason : "too_few_folds" };
  }
  for (const fold of walk.folds) {
    const rhoOk = fold.rhoPnl >= 0.15 && fold.rhoMfe >= 0.15;
    const economicsOk =
      fold.ordered &&
      fold.topMedianPnl > fold.baselineMedianPnl &&
      fold.topRunner10 > fold.baselineRunner10 &&
      fold.topMfe > fold.baselineMfe &&
      fold.topMae != null &&
      fold.baselineMae != null &&
      fold.topMae >= fold.baselineMae - 5 &&
      fold.bootstrapSupport === true &&
      fold.permutationBeatsNull === true &&
      fold.tailDependent !== true &&
      fold.temporal === true;
    if (rhoOk && !economicsOk) return { pass: false, livePromotion: false, reason: "correlation_alone_is_not_a_pass" };
    if (!rhoOk) return { pass: false, livePromotion: false, reason: "rho" };
    if (!economicsOk) return { pass: false, livePromotion: false, reason: "economics" };
  }
  return { pass: true, livePromotion: false, reason: "research_gate" };
}

function summarizeHorizon(rows) {
  const economic = rows.filter((r) => r.outcome && !r.outcome.abstain && typeof r.pnl === "number");
  const premiums = economic.map((r) => r.entryPremiumPct).filter((v) => typeof v === "number");
  const pnls = economic.map((r) => r.pnl);
  const flow = rows.filter((r) => r.features && r.features.uniqueNonCreatorBuyers > 0);
  const cov = {};
  for (const name of O1_FEATURES) cov[name] = coverage(rows, name);
  const fit = O1_FEATURES.filter((name) => cov[name].eligible);
  const walk = walkForward(economic, O1_FEATURES);
  const strict = strictResearchPass(walk, economic);
  const stats = cohortStats(economic);
  return {
    eligibleN: economic.length,
    featureRows: rows.length,
    independentFlowCoverage: rows.length ? flow.length / rows.length : 0,
    independentFlowN: flow.length,
    featureCoverage: cov,
    fitFeatures: fit,
    entryPremiumMedian: pctile(premiums, 50),
    entryPremiumP50: pctile(premiums, 50),
    entryPremiumP90: pctile(premiums, 90),
    medianPnl: stats.medianPnl,
    trimmedPnl: stats.trimmedPnl,
    runner10: stats.runner10,
    mfe: stats.mfe,
    mae: stats.mae,
    catastrophic: stats.catastrophic,
    rhoPnl: walk.folds.length ? walk.folds.map((f) => f.rhoPnl) : [],
    rhoMfe: walk.folds.length ? walk.folds.map((f) => f.rhoMfe) : [],
    top5MedianPnl: walk.folds.length ? walk.folds.map((f) => f.topMedianPnl) : [],
    walk,
    strict,
  };
}

function healthFromBook(book) {
  const launches = [...book.launches.values()];
  const withCreate = launches.filter((l) => l.create && l.create.confident);
  const withTrade = launches.filter((l) => l.trades.some((t) => reservesOf(t)));
  const complete2 = launches.filter((l) => pathComplete(l, COMPLETE_2S_MS));
  const complete30 = launches.filter((l) => pathComplete(l, COMPLETE_30S_MS));
  const sources = {};
  for (const launch of launches) {
    for (const src of launch.sources) sources[src.source || "unknown"] = (sources[src.source || "unknown"] || 0) + 1;
    for (const trade of launch.trades) sources[trade.source || "unknown"] = (sources[trade.source || "unknown"] || 0) + 1;
  }
  const byHorizon = {};
  for (const horizon of HORIZONS) {
    const rows = buildHorizonRows(book, horizon, { nonMayhem: true });
    byHorizon[horizon] = {
      pathEligible: rows.length,
      economic: rows.filter((r) => r.outcome && !r.outcome.abstain).length,
      independentFlow: rows.filter((r) => r.features.uniqueNonCreatorBuyers > 0).length,
    };
  }
  return {
    featureVersion: FEATURE_VERSION,
    launches: launches.length,
    launchesWithCreateState: withCreate.length,
    launchesWithTradeState: withTrade.length,
    launchesWithComplete2sPath: complete2.length,
    launchesWithComplete30sPath: complete30.length,
    tradeObservations: book.tradeObservations,
    executedTradeStates: book.executedTradeStates,
    duplicateMerges: book.duplicateMerges,
    leakage: book.leakage,
    sources,
    pathCoverageByHorizon: byHorizon,
    geyserConfigured: Boolean(process.env.GEYSER_ENDPOINT),
  };
}

function listenerFrontier(book) {
  const pairs = [];
  const firstShare = {};
  let logsOnly = 0;
  let preOnly = 0;
  const bySig = new Map();
  for (const launch of book.launches.values()) {
    for (const src of launch.sources.concat(launch.trades)) {
      if (!src.txSignature || !src.source || !Number.isFinite(src.observedAt)) continue;
      if (!bySig.has(src.txSignature)) bySig.set(src.txSignature, {});
      const bag = bySig.get(src.txSignature);
      const key = src.source;
      if (bag[key] == null || src.observedAt < bag[key]) bag[key] = src.observedAt;
    }
  }
  for (const bag of bySig.values()) {
    const present = Object.keys(bag);
    if (!present.length) continue;
    const first = present.slice().sort((a, b) => bag[a] - bag[b])[0];
    firstShare[first] = (firstShare[first] || 0) + 1;
    if (bag.processed_logs != null && bag.helius_preprocessed != null) {
      pairs.push(bag.processed_logs - bag.helius_preprocessed);
    }
    if (bag.processed_logs != null && bag.helius_preprocessed == null) logsOnly += 1;
    if (bag.helius_preprocessed != null && bag.processed_logs == null) preOnly += 1;
  }
  return {
    paired: pairs.length,
    leadP10: pctile(pairs, 10),
    leadP50: pctile(pairs, 50),
    leadP90: pctile(pairs, 90),
    sourceFirstShare: firstShare,
    logsWithoutPreprocessed: logsOnly,
    preprocessedWithoutLogs: preOnly,
    geyserConfigured: Boolean(process.env.GEYSER_ENDPOINT),
  };
}

function verdictFrom(health, horizons) {
  const economic = Math.max(...HORIZONS.map((h) => horizons[h].eligibleN));
  if (health.launchesWithComplete2sPath < MIN_EFFECTIVE_N || economic < MIN_EFFECTIVE_N) {
    return "INSUFFICIENT_EXECUTED_STATE_COVERAGE";
  }
  const anyStrict = HORIZONS.some((h) => horizons[h].strict && horizons[h].strict.pass && horizons[h].medianPnl > 0);
  if (anyStrict) return "EARLY_EDGE_EXISTS";
  const signal = HORIZONS.some((h) => (horizons[h].rhoPnl || []).some((r) => r >= 0.15));
  const priced = HORIZONS.some((h) => (horizons[h].entryPremiumMedian || 0) > 0 && !(horizons[h].medianPnl > 0));
  if (signal && priced) return "SIGNAL_EXISTS_BUT_ALREADY_PRICED";
  return "NO_WALLET_FLOW_EDGE";
}

function evaluateBook(book) {
  const health = healthFromBook(book);
  const horizons = {};
  const riskLow = {};
  for (const horizon of HORIZONS) {
    const rows = buildHorizonRows(book, horizon, { nonMayhem: true });
    horizons[horizon] = summarizeHorizon(rows);
    riskLow[horizon] = summarizeHorizon(rows);
  }
  const mayhem = {};
  for (const horizon of HORIZONS) {
    mayhem[horizon] = summarizeHorizon(buildHorizonRows(book, horizon, { mayhemOnly: true }));
  }
  const models = {};
  const modelRows = buildHorizonRows(book, "1000", { nonMayhem: true }).filter((r) => typeof r.pnl === "number");
  for (const [name, features] of Object.entries(MODELS)) {
    const walk = walkForward(modelRows, features);
    models[name] = {
      features,
      walk,
      strict: strictResearchPass(walk, modelRows),
      livePromotion: false,
    };
  }
  const verdict = verdictFrom(health, horizons);
  return {
    featureVersion: FEATURE_VERSION,
    epoch: RESEARCH_EPOCH,
    researchBuySol: RESEARCH_BUY_SOL,
    horizons,
    riskLowSubgroup: riskLow,
    mayhemSeparate: mayhem,
    models,
    health,
    listener: listenerFrontier(book),
    verdict,
    liveStatus: "UNCHANGED",
    shadowCanPromoteLive: false,
    pass: false,
    liveTrading: "OFF",
    kill: "ON",
  };
}

function assertNoLivePromotion(text) {
  for (const phrase of FORBIDDEN_LIVE_TEXT) {
    if (text.includes(phrase)) throw new Error("forbidden live promotion text: " + phrase);
  }
}

module.exports = {
  FEATURE_VERSION,
  EVENT_TYPE,
  RESEARCH_EPOCH,
  SOL_MINT,
  USDC_MINT,
  RESEARCH_BUY_SOL,
  RESEARCH_BUY_LAMPORTS,
  HORIZONS,
  HORIZON_MS,
  O1_FEATURES,
  MODELS,
  TRADE_DISC,
  CREATE_DISC,
  emptyBook,
  parseTradeEvent,
  parseCreateEvent,
  parseCompleteEvent,
  parseMigrationEvent,
  observeCreate,
  observeTrade,
  observeCutoff,
  observeSource,
  observeMigration,
  noteLogs,
  quotePumpBuy,
  quotePumpSell,
  quotePumpSwap,
  quoteRaydiumAmountOut,
  observeJupiterRoute,
  snapshotFeatures,
  entryAt,
  outcomeAt,
  stateAt,
  buildHorizonRows,
  healthFromBook,
  evaluateBook,
  walkForward,
  strictResearchPass,
  assertNoLivePromotion,
  firstObservedAt,
  pathComplete,
};
