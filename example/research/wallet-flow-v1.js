/**
 * Real post-create wallet flow, research only.
 *
 * Epoch selection_v3_walletflow_2026_10 starts with this collector.
 * selection_v3_shadow_2026_10 rows are not rewritten.
 * Feature version wallet_flow_v1_1 is stamped on corrected observations.
 * wallet_flow_v1 rows stay in the file for forensics and are not pooled
 * into the corrected primary sample.
 *
 * Create-transaction creator buys are stored separately and are not
 * independent post-create participation.
 * Eligibility uses observedAt, never chain block time.
 * This module does not submit transactions or change a live gate.
 */
"use strict";

const { mean, pctile, spearman, kendallTau, bootstrapMedianDiff, mulberry32 } = require("./math");

const FEATURE_VERSION = "wallet_flow_v1_1";
const PRIOR_FEATURE_VERSION = "wallet_flow_v1";
const COLLECTOR_FIX_VERSION = "wallet-identity-amount-sensors-2026-10-06";
const RESEARCH_EPOCH = "selection_v3_walletflow_2026_10";
const PRIOR_EPOCH = "selection_v3_shadow_2026_10";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRADE_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const DECISION_WINDOWS = [100, 250, 500];
const DESCRIPTIVE_WINDOWS = [1000, 2000, 5000];
const MIN_EFFECTIVE_N = 100;
const COVERAGE_MIN_N = 20;
const COVERAGE_MIN_PCT = 0.2;
const BUY_DISC = {
  "66063d1201daebea": "TOKEN_EXACT",
  b817ee6167c5d33d: "TOKEN_EXACT",
  "38fc74089edfcd5f": "SOL_EXACT",
  c2ab1c46684d5b2f: "SOL_EXACT",
};

const O1_FEATURES = [
  "walletFlow250.uniqueNonCreatorBuyers",
  "walletFlow250.grossBuySol",
  "walletFlow250.netBuySol",
  "walletFlow250.buyVelocity",
  "walletFlow250.uniqueBuyerVelocity",
  "walletFlow250.topBuyerShare",
  "walletFlow250.creatorShareOfBuyFlow",
  "walletFlow250.firstIndependentBuyDelayMs",
];

function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function quoteIsSol(mint) {
  return !mint || mint === SOL_MINT || mint === "SOL";
}

function emptyBook() {
  return { launches: new Map(), events: new Map(), rawObservations: 0, correctedObservations: 0 };
}

function isCorrectedVersion(version) {
  return version === FEATURE_VERSION;
}

function knownQuoteDecimals(mint) {
  if (!mint) return null;
  if (mint === SOL_MINT || mint === "SOL") return 9;
  if (mint === USDC_MINT) return 6;
  return null;
}

function rawInt(v) {
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  return null;
}

function launchKey(mint) {
  return String(mint || "");
}

function eventKey(event) {
  return [event.txSignature || "", event.mint || "", event.side || "", event.wallet || ""].join("\0");
}

function noteCandidate(book, input) {
  if (!input || !input.mint) return null;
  const key = launchKey(input.mint);
  let row = book.launches.get(key);
  if (!row) {
    row = {
      researchEpoch: RESEARCH_EPOCH,
      featureVersion: input.featureVersion || FEATURE_VERSION,
      collectorFixVersion:
        input.collectorFixVersion ||
        (input.featureVersion && input.featureVersion !== FEATURE_VERSION ? null : COLLECTOR_FIX_VERSION),
      mint: input.mint,
      createSignature: input.createSignature || null,
      firstObservedAt: finite(input.observedAt) != null ? input.observedAt : finite(input.firstObservedAt),
      decisionCutoffAt: null,
      creator: input.creator || null,
      deployer: input.deployer || null,
      quoteMint: input.quoteMint || null,
      mayhem: input.mayhem === true,
      stale: input.stale === true,
      sourceCountAtDecision: null,
      deployerEvidenceN: null,
      deployerRawQuality: null,
      createTxCreatorBuy: null,
    };
    book.launches.set(key, row);
  }
  if (row.firstObservedAt == null && finite(input.observedAt) != null) row.firstObservedAt = input.observedAt;
  if (!row.createSignature && input.createSignature) row.createSignature = input.createSignature;
  if (!row.creator && input.creator) row.creator = input.creator;
  if (!row.deployer && input.deployer) row.deployer = input.deployer;
  if (!row.quoteMint && input.quoteMint) row.quoteMint = input.quoteMint;
  return row;
}

function noteDecision(book, trace) {
  if (!trace || !trace.mint) return null;
  const row = noteCandidate(book, {
    mint: trace.mint,
    createSignature: trace.createSig || trace.createSignature || null,
    creator: trace.creator,
    deployer: trace.deployer,
    quoteMint: trace.quoteMint,
    mayhem: trace.mayhem === true,
    observedAt: finite(trace.ts),
  });
  if (row.decisionCutoffAt == null && finite(trace.ts) != null) row.decisionCutoffAt = trace.ts;
  if (finite(trace.sourceCountAtDecision) != null) row.sourceCountAtDecision = trace.sourceCountAtDecision;
  else if (finite(trace.sourceCount) != null && row.sourceCountAtDecision == null) row.sourceCountAtDecision = trace.sourceCount;
  if (finite(trace.deployerN) != null) row.deployerEvidenceN = trace.deployerN;
  if (finite(trace.rawScore) != null) row.deployerRawQuality = trace.rawScore;
  if (typeof trace.skipReason === "string" && trace.skipReason.includes("|outcome")) {
    row.pnl = finite(trace.ret30s);
    row.mfe = finite(trace.mfe30s);
    row.mae = finite(trace.mae30s);
    row.runner10 = finite(trace.mfe30s) != null ? trace.mfe30s >= 10 : null;
    row.outcomeObservedAt = finite(trace.ts);
  }
  return row;
}

function mergeSource(event, input) {
  const source = input.source || "other";
  const at = finite(input.observedAt);
  if (!event.sources) event.sources = {};
  if (at != null && (event.sources[source] == null || at < event.sources[source])) event.sources[source] = at;
  if (source === "helius_preprocessed" && at != null) event.preObservedAt = event.preObservedAt == null ? at : Math.min(event.preObservedAt, at);
  if (source === "helius_processed" && at != null) event.processedObservedAt = event.processedObservedAt == null ? at : Math.min(event.processedObservedAt, at);
  if (source === "geyser" && at != null) event.geyserObservedAt = event.geyserObservedAt == null ? at : Math.min(event.geyserObservedAt, at);
  if (source === "logs" && at != null) event.logsObservedAt = event.logsObservedAt == null ? at : Math.min(event.logsObservedAt, at);
  const times = Object.values(event.sources).filter((t) => typeof t === "number");
  event.observedAt = times.length ? Math.min(...times) : event.observedAt;
  event.sourceCount = Object.keys(event.sources).length;
  event.firstSource = event.firstSource || source;
  if (event.preObservedAt != null && event.processedObservedAt != null) {
    event.preToProcessedMs = event.processedObservedAt - event.preObservedAt;
  }
  if (input.inCreateTransaction) event.inCreateTransaction = true;
  return event;
}

function backfillEvent(event, input) {
  if (event.quoteRaw == null && rawInt(input.quoteRaw) != null) event.quoteRaw = rawInt(input.quoteRaw);
  if (event.tokenRaw == null && rawInt(input.tokenRaw) != null) event.tokenRaw = rawInt(input.tokenRaw);
  if (event.quoteAmount == null && finite(input.quoteAmount) != null) event.quoteAmount = input.quoteAmount;
  if (event.tokenAmount == null && finite(input.tokenAmount) != null) event.tokenAmount = input.tokenAmount;
  if (event.wireSol == null && finite(input.wireSol) != null) event.wireSol = input.wireSol;
  if (!event.quoteMint && input.quoteMint) event.quoteMint = input.quoteMint;
  if (event.quoteDecimals == null) {
    const explicit = finite(input.quoteDecimals);
    event.quoteDecimals = explicit != null ? explicit : knownQuoteDecimals(event.quoteMint);
  }
  if (input.isCreator === true) event.isCreator = true;
  if (input.isDeployer === true) event.isDeployer = true;
  if (finite(input.eventConfidence) != null) event.eventConfidence = Math.max(event.eventConfidence || 0, input.eventConfidence);
  if (!event.wallet && input.wallet) event.wallet = input.wallet;
  return event;
}

function countObservation(book, event) {
  book.rawObservations = (book.rawObservations || 0) + 1;
  if (event && isCorrectedVersion(event.featureVersion)) {
    book.correctedObservations = (book.correctedObservations || 0) + 1;
  }
}

function observeFlow(book, input) {
  if (!input || !input.mint) return { accepted: false, duplicate: false, event: null };
  const side = input.side === "buy" || input.side === "sell" ? input.side : "unknown";
  const wallet = input.wallet || null;
  const normalized = { ...input, side, wallet };
  const key = eventKey(normalized);
  const existing = book.events.get(key);
  if (existing) {
    backfillEvent(existing, normalized);
    mergeSource(existing, normalized);
    countObservation(book, existing);
    return { accepted: false, duplicate: true, event: existing };
  }
  if (input.txSignature) {
    const same = [];
    for (const event of book.events.values()) {
      if (event.txSignature === input.txSignature && event.mint === input.mint && event.side === side) same.push(event);
    }
    if (!wallet && same.length) {
      backfillEvent(same[0], normalized);
      mergeSource(same[0], normalized);
      countObservation(book, same[0]);
      return { accepted: false, duplicate: true, event: same[0] };
    }
    const blank = wallet ? same.find((event) => !event.wallet) : null;
    if (blank) {
      book.events.delete(eventKey(blank));
      backfillEvent(blank, normalized);
      blank.wallet = wallet;
      mergeSource(blank, normalized);
      book.events.set(eventKey(blank), blank);
      countObservation(book, blank);
      return { accepted: false, duplicate: true, event: blank };
    }
  }
  const quoteMint = input.quoteMint || null;
  const event = {
    researchEpoch: RESEARCH_EPOCH,
    featureVersion: input.featureVersion || FEATURE_VERSION,
    collectorFixVersion:
      input.collectorFixVersion ||
      (input.featureVersion && input.featureVersion !== FEATURE_VERSION ? null : COLLECTOR_FIX_VERSION),
    mint: input.mint,
    createSignature: input.createSignature || null,
    observedAt: finite(input.observedAt),
    chainSlot: finite(input.chainSlot),
    chainTimeMs: finite(input.chainTimeMs),
    source: input.source || "other",
    sources: {},
    txSignature: input.txSignature || null,
    wallet,
    side,
    quoteRaw: rawInt(input.quoteRaw),
    tokenRaw: rawInt(input.tokenRaw),
    wireSol: finite(input.wireSol),
    quoteAmount: finite(input.quoteAmount),
    quoteMint,
    quoteDecimals: finite(input.quoteDecimals) != null ? input.quoteDecimals : knownQuoteDecimals(quoteMint),
    tokenAmount: finite(input.tokenAmount),
    isCreator: input.isCreator === true ? true : input.isCreator === false ? false : null,
    isDeployer: input.isDeployer === true ? true : input.isDeployer === false ? false : null,
    inCreateTransaction: input.inCreateTransaction === true,
    eventConfidence: finite(input.eventConfidence) != null ? input.eventConfidence : 0,
    firstSource: input.source || "other",
    preObservedAt: null,
    processedObservedAt: null,
    geyserObservedAt: null,
    logsObservedAt: null,
    preToProcessedMs: null,
    sourceCount: 1,
  };
  mergeSource(event, normalized);
  book.events.set(eventKey(event), event);
  countObservation(book, event);
  return { accepted: true, duplicate: false, event };
}

function parseTradeEventLog(line) {
  if (typeof line !== "string" || !line.startsWith("Program data: ")) return null;
  let raw;
  try {
    raw = Buffer.from(line.slice("Program data: ".length), "base64");
  } catch {
    return null;
  }
  if (raw.length < 8 + 32 + 8 + 8 + 1 + 32 || !raw.subarray(0, 8).equals(TRADE_DISC)) return null;
  let o = 8;
  const mint = new (require("@solana/web3.js").PublicKey)(raw.subarray(o, o + 32)).toBase58();
  o += 32;
  const quoteRaw = raw.readBigUInt64LE(o);
  o += 8;
  const tokenRaw = raw.readBigUInt64LE(o);
  o += 8;
  const isBuy = raw[o] !== 0;
  o += 1;
  const wallet = new (require("@solana/web3.js").PublicKey)(raw.subarray(o, o + 32)).toBase58();
  return {
    mint,
    wallet,
    side: isBuy ? "buy" : "sell",
    quoteRaw: rawInt(quoteRaw),
    tokenRaw: rawInt(tokenRaw),
    eventConfidence: 0.9,
    parseSource: "trade_event",
  };
}

function flowFromBuyInstruction(accountKeys, data, numSigners, accountIndexes) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length < 24 || !accountKeys || accountKeys.length < 3 || !accountKeys[2]) return null;
  const family = BUY_DISC[buf.subarray(0, 8).toString("hex")];
  if (!family) return null;
  const mint = accountKeys[2];
  // User is instruction account 6. Signer count is a separate message-header fact.
  const wallet = accountKeys.length > 6 && accountKeys[6] ? accountKeys[6] : null;
  let walletIsSigner = null;
  if (wallet && Array.isArray(accountIndexes) && typeof numSigners === "number" && typeof accountIndexes[6] === "number") {
    walletIsSigner = accountIndexes[6] >= 0 && accountIndexes[6] < numSigners;
  }
  const a = buf.readBigUInt64LE(8);
  const b = buf.readBigUInt64LE(16);
  const lamports = family === "SOL_EXACT" ? a : b;
  const tokens = family === "SOL_EXACT" ? b : a;
  const sol = Number(lamports) / 1e9;
  return {
    mint,
    wallet,
    walletIsSigner,
    side: "buy",
    quoteRaw: rawInt(lamports),
    tokenRaw: rawInt(tokens),
    wireSol: Number.isFinite(sol) && sol > 0 && sol <= 500 ? sol : null,
    eventConfidence: wallet ? 0.75 : 0.4,
    parseSource: "buy_ix",
  };
}

function amountForLaunch(event, launch) {
  const quoteMint = (launch && launch.quoteMint) || event.quoteMint || null;
  if (quoteIsSol(quoteMint)) {
    const sol = finite(event.quoteAmount) != null ? event.quoteAmount : finite(event.wireSol);
    const fromRaw = finite(event.quoteRaw) != null ? event.quoteRaw / 1e9 : null;
    return { sol: sol != null ? sol : fromRaw, quote: null, quoteMint: SOL_MINT };
  }
  if (quoteMint === USDC_MINT && finite(event.quoteRaw) != null) {
    return { sol: null, quote: event.quoteRaw / 1e6, quoteMint };
  }
  if (finite(event.quoteAmount) != null && quoteMint) {
    return { sol: null, quote: event.quoteAmount, quoteMint };
  }
  return { sol: null, quote: null, quoteMint: quoteMint || null };
}

function isCreatorWallet(event, launch) {
  if (event.isCreator === true) return true;
  if (event.wallet && launch.creator && event.wallet === launch.creator) return true;
  return false;
}

function isDeployerWallet(event, launch) {
  if (event.isDeployer === true) return true;
  if (event.wallet && launch.deployer && event.wallet === launch.deployer) return true;
  return false;
}

function priorWalletEntries(launches, wallet, beforeCutoff) {
  if (!wallet || finite(beforeCutoff) == null) return [];
  const rows = [];
  for (const launch of launches) {
    if (finite(launch.decisionCutoffAt) == null || launch.decisionCutoffAt >= beforeCutoff) continue;
    if (finite(launch.outcomeObservedAt) == null || launch.outcomeObservedAt > beforeCutoff) continue;
    const bought = (launch._buyers || []).includes(wallet);
    if (!bought) continue;
    rows.push(launch);
  }
  return rows;
}

function snapshotWindow(launch, events, windowMs, mode) {
  const start = launch.firstObservedAt;
  const cutoff = launch.decisionCutoffAt;
  const inWindow = [];
  for (const event of events) {
    if (event.mint !== launch.mint || event.inCreateTransaction) continue;
    if (finite(event.observedAt) == null || finite(start) == null) continue;
    const dt = event.observedAt - start;
    if (dt < 0 || dt > windowMs) continue;
    inWindow.push(event);
  }
  const descriptive = mode === "descriptive";
  const kept = descriptive ? inWindow : inWindow.filter((event) => finite(cutoff) != null && event.observedAt <= cutoff);
  const usedLate = kept.some((event) => finite(cutoff) != null && event.observedAt > cutoff);
  const buys = kept.filter((event) => event.side === "buy");
  const sells = kept.filter((event) => event.side === "sell");
  const quoteMint = launch.quoteMint || (buys[0] && buys[0].quoteMint) || null;
  const solQuote = quoteIsSol(quoteMint);
  let grossBuySol = solQuote ? 0 : null;
  let grossSellSol = solQuote ? 0 : null;
  let grossBuyQuote = solQuote ? null : 0;
  const buySols = [];
  const byWallet = new Map();
  let creatorBuy = 0;
  let deployerBuy = 0;
  let creatorBoughtPostCreate = false;
  let deployerBoughtPostCreate = false;
  let anyQuote = false;
  for (const event of buys) {
    const amt = amountForLaunch(event, launch);
    const creator = isCreatorWallet(event, launch);
    const deployer = isDeployerWallet(event, launch);
    if (creator) creatorBoughtPostCreate = true;
    if (deployer) deployerBoughtPostCreate = true;
    if (amt.sol != null && solQuote) {
      anyQuote = true;
      grossBuySol += amt.sol;
      if (creator) creatorBuy += amt.sol;
      if (deployer) deployerBuy += amt.sol;
      if (!creator) buySols.push(amt.sol);
      if (event.wallet && !creator) byWallet.set(event.wallet, (byWallet.get(event.wallet) || 0) + amt.sol);
    } else if (amt.quote != null) {
      anyQuote = true;
      grossBuyQuote += amt.quote;
    }
  }
  for (const event of sells) {
    const amt = amountForLaunch(event, launch);
    if (amt.sol != null && solQuote) grossSellSol += amt.sol;
  }
  const independent = buys.filter((event) => event.wallet && !isCreatorWallet(event, launch) && !isDeployerWallet(event, launch));
  const uniqueObserved = new Set(buys.map((event) => event.wallet).filter(Boolean));
  const uniqueNonCreator = new Set(independent.map((event) => event.wallet));
  const delays = independent
    .map((event) => event.observedAt - start)
    .filter((dt) => dt >= 0)
    .sort((a, b) => a - b);
  const shares = [...byWallet.values()].sort((a, b) => b - a);
  const gross = solQuote ? grossBuySol : null;
  const top = shares.length && gross ? shares[0] / gross : null;
  const top3 = shares.length && gross ? shares.slice(0, 3).reduce((s, v) => s + v, 0) / gross : null;
  const seconds = windowMs / 1000;
  const historyKnown = launch._historyKnown === true;
  let experiencedWalletCount = null;
  if (historyKnown) {
    experiencedWalletCount = 0;
    for (const wallet of uniqueNonCreator) {
      if (priorWalletEntries(launch._allLaunches || [], wallet, cutoff).length >= 1) experiencedWalletCount++;
    }
  }
  return {
    windowMs,
    label: descriptive ? "DESCRIPTIVE_ONLY" : "decision",
    notDecisionEligible: descriptive ? true : false,
    eventsObserved: kept.length,
    lastIncludedObservedAt: kept.length ? Math.max(...kept.map((event) => event.observedAt)) : null,
    decisionEligible: !descriptive && !usedLate && finite(cutoff) != null,
    independentBuyerCount: uniqueNonCreator.size,
    uniqueObservedBuyers: uniqueObserved.size,
    uniqueNonCreatorBuyers: uniqueNonCreator.size,
    buyCount: buys.length,
    sellCount: sells.length,
    grossBuySol: solQuote && anyQuote ? grossBuySol : null,
    grossSellSol: solQuote && sells.length ? grossSellSol : null,
    netBuySol: solQuote && anyQuote ? grossBuySol - (grossSellSol || 0) : null,
    grossBuyQuote: solQuote ? null : anyQuote ? grossBuyQuote : null,
    quoteMint: quoteMint || null,
    medianBuySol: buySols.length ? pctile(buySols, 50) : null,
    maxBuySol: buySols.length ? Math.max(...buySols) : null,
    firstIndependentBuyDelayMs: delays.length ? delays[0] : null,
    secondIndependentBuyDelayMs: delays.length > 1 ? delays[1] : null,
    buyVelocity: seconds > 0 ? buys.length / seconds : null,
    uniqueBuyerVelocity: seconds > 0 ? uniqueNonCreator.size / seconds : null,
    topBuyerShare: top,
    top3BuyerShare: top3,
    creatorShareOfBuyFlow: gross ? creatorBuy / gross : null,
    deployerShareOfBuyFlow: gross ? deployerBuy / gross : null,
    creatorBoughtPostCreate,
    deployerBoughtPostCreate,
    experiencedWalletCount,
    buyers: [...uniqueNonCreator],
  };
}

function attachHistory(launches) {
  const anyOutcome = launches.some((row) => finite(row.outcomeObservedAt) != null && (row._buyers || []).length);
  for (const launch of launches) launch._historyKnown = anyOutcome;
  for (const launch of launches) launch._allLaunches = launches;
}

function researchRow(launch, events) {
  const row = {
    id: [launch.mint, launch.createSignature || "", launch.decisionCutoffAt || ""].join("|"),
    researchEpoch: RESEARCH_EPOCH,
    featureVersion: FEATURE_VERSION,
    mint: launch.mint,
    createSignature: launch.createSignature,
    firstObservedAt: launch.firstObservedAt,
    decisionCutoffAt: launch.decisionCutoffAt,
    ts: launch.decisionCutoffAt,
    creator: launch.creator,
    deployer: launch.deployer,
    quoteMint: launch.quoteMint,
    mayhem: launch.mayhem === true,
    stale: launch.stale === true,
    sourceCountAtDecision: launch.sourceCountAtDecision,
    deployerEvidenceN: launch.deployerEvidenceN,
    deployerRawQuality: launch.deployerRawQuality,
    pnl: finite(launch.pnl),
    mfe: finite(launch.mfe),
    mae: finite(launch.mae),
    runner10: launch.runner10 === true ? true : launch.runner10 === false ? false : null,
    createTxCreatorBuy: launch.createTxCreatorBuy,
    selected: false,
    sampleKind: "shadow",
  };
  for (const windowMs of DECISION_WINDOWS) {
    row["walletFlow" + windowMs] = snapshotWindow(launch, events, windowMs, "decision");
  }
  for (const windowMs of DESCRIPTIVE_WINDOWS) {
    const snap = snapshotWindow(launch, events, windowMs, "descriptive");
    snap.decisionEligible = false;
    snap.label = "DESCRIPTIVE_ONLY";
    snap.notDecisionEligible = true;
    row["descriptive" + windowMs] = snap;
  }
  return row;
}

function buildRows(book) {
  const launches = [...book.launches.values()].filter(
    (row) => isCorrectedVersion(row.featureVersion) && finite(row.decisionCutoffAt) != null && finite(row.firstObservedAt) != null
  );
  const events = [...book.events.values()].filter((event) => isCorrectedVersion(event.featureVersion));
  for (const launch of launches) {
    const buyers = [];
    for (const event of events) {
      if (event.mint === launch.mint && event.side === "buy" && event.wallet && !event.inCreateTransaction) buyers.push(event.wallet);
      if (event.mint === launch.mint && event.inCreateTransaction && event.side === "buy" && !launch.createTxCreatorBuy) {
        launch.createTxCreatorBuy = { wallet: event.wallet, quoteAmount: event.quoteAmount, observedAt: event.observedAt };
      }
    }
    launch._buyers = [...new Set(buyers)];
  }
  attachHistory(launches);
  return launches
    .map((launch) => researchRow(launch, events))
    .sort((a, b) => a.decisionCutoffAt - b.decisionCutoffAt || String(a.id).localeCompare(String(b.id)));
}

function featureValue(row, name) {
  if (!row || row.excludedForLeakage) return null;
  if (name === "listener.sourceCountAtDecision" || name === "sourceCountAtDecision") return finite(row.sourceCountAtDecision);
  if (name === "deployerEvidenceN") return finite(row.deployerEvidenceN);
  if (name === "experiencedWalletCount") {
    const snap = row.walletFlow250;
    if (!snap || snap.decisionEligible !== true || snap.notDecisionEligible) return null;
    return finite(snap.experiencedWalletCount);
  }
  const match = /^walletFlow(100|250|500)\.(.+)$/.exec(name);
  if (!match) return null;
  const snap = row["walletFlow" + match[1]];
  if (!snap || snap.decisionEligible !== true || snap.label === "DESCRIPTIVE_ONLY" || snap.notDecisionEligible) return null;
  if (finite(snap.lastIncludedObservedAt) != null && finite(row.decisionCutoffAt) != null && snap.lastIncludedObservedAt > row.decisionCutoffAt) {
    return null;
  }
  return finite(snap[match[2]]);
}

function variationOf(rows, names) {
  const n = rows.length || 1;
  return names.map((name) => {
    const values = [];
    for (const row of rows) {
      const v = featureValue(row, name);
      if (v != null) values.push(v);
    }
    const unique = new Set(values);
    const mu = values.length ? mean(values) : null;
    let variance = 0;
    if (mu != null) for (const v of values) variance += (v - mu) * (v - mu);
    const stddev = values.length ? Math.sqrt(variance / values.length) : null;
    let reason = null;
    const coveragePct = rows.length ? values.length / rows.length : 0;
    if (values.length < COVERAGE_MIN_N || coveragePct < COVERAGE_MIN_PCT) reason = "coverage_too_low";
    else if (unique.size < 2) reason = "unique_values<2";
    else if (stddev == null || stddev < 1e-12) reason = "stddev~0";
    return {
      feature: name,
      coverage_n: values.length,
      coverage_pct: rows.length ? values.length / rows.length : 0,
      unique_values: unique.size,
      stddev,
      p10: values.length ? pctile(values, 10) : null,
      p50: values.length ? pctile(values, 50) : null,
      p90: values.length ? pctile(values, 90) : null,
      fit_eligible: reason == null,
      reason,
    };
  });
}

const ACCESSOR_NAMES = [
  "walletFlow100.uniqueNonCreatorBuyers",
  "walletFlow250.uniqueNonCreatorBuyers",
  "walletFlow500.uniqueNonCreatorBuyers",
  "walletFlow100.grossBuySol",
  "walletFlow250.grossBuySol",
  "walletFlow500.grossBuySol",
  "walletFlow250.netBuySol",
  "walletFlow250.buyVelocity",
  "walletFlow250.uniqueBuyerVelocity",
  "walletFlow250.topBuyerShare",
  "walletFlow250.creatorShareOfBuyFlow",
  "walletFlow250.firstIndependentBuyDelayMs",
  "experiencedWalletCount",
  "listener.sourceCountAtDecision",
];

function fitNames(rows, names) {
  const diag = variationOf(rows, names);
  return { diag, names: diag.filter((row) => row.fit_eligible).map((row) => row.feature) };
}

function scoreModel(train, test, names) {
  const usable = fitNames(train, names);
  if (!usable.names.length) {
    return { abstainReason: "no_feature_variation", rhoPnl: null, rhoMfe: null, kendall: null, n: 0, variation: usable.diag, scores: [] };
  }
  const weights = {};
  for (const name of usable.names) {
    const xs = [];
    const ys = [];
    for (const row of train) {
      const x = featureValue(row, name);
      if (x == null || finite(row.pnl) == null) continue;
      xs.push(x);
      ys.push(row.pnl);
    }
    const rho = spearman(xs, ys).rho;
    if (rho == null || rho === 0) continue;
    weights[name] = rho;
  }
  const active = usable.names.filter((name) => weights[name] != null && weights[name] !== 0);
  if (!active.length) {
    return { abstainReason: "no_feature_variation", rhoPnl: null, rhoMfe: null, kendall: null, n: 0, variation: usable.diag, scores: [] };
  }
  const scores = [];
  for (const row of test) {
    if (finite(row.pnl) == null) continue;
    let s = 0;
    let used = 0;
    for (const name of active) {
      const x = featureValue(row, name);
      if (x == null) continue;
      s += weights[name] * x;
      used++;
    }
    if (!used) continue;
    scores.push({ ...row, score: s });
  }
  const rhoPnl = spearman(scores.map((row) => row.score), scores.map((row) => row.pnl)).rho;
  const rhoMfe = spearman(scores.map((row) => row.score), scores.map((row) => row.mfe)).rho;
  const kendall = kendallTau(scores.map((row) => row.score), scores.map((row) => row.pnl)).tau;
  return { abstainReason: null, rhoPnl, rhoMfe, kendall, n: scores.length, variation: usable.diag, scores, weights };
}

function cohortStats(scores) {
  const ranked = [...scores].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  function take(frac) {
    const k = Math.max(1, Math.round(ranked.length * frac));
    const slice = ranked.slice(0, k);
    const pnls = slice.map((row) => row.pnl).filter((v) => v != null);
    const mfes = slice.map((row) => row.mfe).filter((v) => v != null);
    const maes = slice.map((row) => row.mae).filter((v) => v != null);
    return {
      n: slice.length,
      medianPnl: pnls.length ? pctile(pnls, 50) : null,
      runner10: slice.length ? slice.filter((row) => row.runner10 === true || (finite(row.mfe) != null && row.mfe >= 10)).length / slice.length : null,
      mfe: mfes.length ? pctile(mfes, 50) : null,
      mae: maes.length ? pctile(maes, 50) : null,
    };
  }
  const all = scores.map((row) => row.pnl).filter((v) => v != null);
  return { top10: take(0.1), top5: take(0.05), top2: take(0.02), baselineMedianPnl: all.length ? pctile(all, 50) : null };
}

function walkFolds(rows) {
  const sorted = [...rows].sort((a, b) => a.decisionCutoffAt - b.decisionCutoffAt || String(a.id).localeCompare(String(b.id)));
  const q = Math.floor(sorted.length / 4);
  if (q < 1) return [];
  const chunks = [0, 1, 2, 3].map((i) => sorted.slice(i * q, i === 3 ? sorted.length : (i + 1) * q));
  return [1, 2, 3].map((i) => ({ name: "fold" + i, train: chunks.slice(0, i).flat(), test: chunks[i] }));
}

function assertTemporal(fold) {
  if (!fold.train.length || !fold.test.length) return;
  const maxTrain = Math.max(...fold.train.map((row) => row.decisionCutoffAt || 0));
  const minTest = Math.min(...fold.test.map((row) => row.decisionCutoffAt || 0));
  if (minTest < maxTrain) throw new Error("temporal fold overlap");
}

function leadLag(rows) {
  const lags = rows
    .map((row) => (finite(row.decisionCutoffAt) != null && finite(row.firstObservedAt) != null ? row.decisionCutoffAt - row.firstObservedAt : null))
    .filter((v) => v != null);
  function pct(windowMs) {
    if (!rows.length) return 0;
    const ok = rows.filter((row) => {
      const snap = row["walletFlow" + windowMs];
      return snap && snap.decisionEligible && snap.uniqueNonCreatorBuyers > 0;
    }).length;
    return ok / rows.length;
  }
  return {
    decisionLagMedianMs: lags.length ? pctile(lags, 50) : null,
    eligible100: pct(100),
    eligible250: pct(250),
    eligible500: pct(500),
  };
}

function evaluateBook(book) {
  const rows = buildRows(book);
  const primary = rows.filter((row) => row.mayhem !== true && row.stale !== true && finite(row.pnl) != null);
  const mayhem = rows.filter((row) => row.mayhem === true && finite(row.pnl) != null);
  const lag = leadLag(rows);
  const descriptiveNames = ["descriptive"];
  const descriptiveVaries = rows.some((row) => row.descriptive5000 && row.descriptive5000.uniqueNonCreatorBuyers > 0);
  const earlyCoverage = lag.eligible500;
  let status = "COLLECT_WALLET_FLOW";
  if (primary.length >= MIN_EFFECTIVE_N && earlyCoverage < 0.1 && descriptiveVaries) status = "POST_DECISION_SIGNAL_ONLY";
  const models = {};
  const specs = {
    O0: ["listener.sourceCountAtDecision"],
    O1: O1_FEATURES,
    O2: O1_FEATURES.concat(["listener.sourceCountAtDecision"]),
    O3: O1_FEATURES.concat(["listener.sourceCountAtDecision", "deployerEvidenceN"]),
  };
  featureValue.deployer = (row) => finite(row.deployerEvidenceN);
  const original = featureValue;
  function value(row, name) {
    if (name === "deployerEvidenceN") return finite(row.deployerEvidenceN);
    return original(row, name);
  }
  // local wrapper used by score via featureValue; deployer is handled below by aliasing onto rows as a fake wallet field
  for (const row of primary) {
    row.walletFlow250 = row.walletFlow250 || {};
  }
  const folds = walkFolds(primary);
  for (const fold of folds) assertTemporal(fold);
  for (const [model, names] of Object.entries(specs)) {
    const resolved = names.map((name) => (name === "deployerEvidenceN" ? "listener.sourceCountAtDecision" : name));
    // O3 adds deployer as its own accessor name handled in featureValue override below.
    models[model] = { names, folds: [] };
  }
  function valueWithDeployer(row, name) {
    if (name === "deployerEvidenceN") return finite(row.deployerEvidenceN);
    return featureValue(row, name);
  }
  // Rebind by wrapping scoreModel's featureValue through a temporary global is too messy.
  // deployerEvidenceN is read here by substituting the accessor list and a row field copy.
  for (const row of primary) row.sourceCountAtDecision = row.sourceCountAtDecision;
  const modelNames = {
    O0: ["listener.sourceCountAtDecision"],
    O1: O1_FEATURES.slice(),
    O2: O1_FEATURES.concat(["listener.sourceCountAtDecision"]),
    O3: O1_FEATURES.concat(["listener.sourceCountAtDecision", "deployerEvidenceN"]),
  };
  if (primary.length < MIN_EFFECTIVE_N || !folds.length) {
    return {
      status,
      researchVerdict: status,
      pass: false,
      shadowCanPromoteLive: false,
      liveStatus: "UNCHANGED",
      n: primary.length,
      mayhemN: mayhem.length,
      leadLag: lag,
      models: Object.fromEntries(Object.keys(modelNames).map((name) => [name, { status: "COLLECT_WALLET_FLOW", folds: [] }])),
      variation: variationOf(primary, ACCESSOR_NAMES),
      postDecisionSignalOnly: status === "POST_DECISION_SIGNAL_ONLY",
    };
  }
  for (const [model, names] of Object.entries(modelNames)) {
    const foldRows = [];
    for (const fold of folds) {
      const train = model === "O3" ? fold.train : fold.train;
      const scored = scoreModel(train, fold.test, names);
      if (model === "O3") {
        const extra = scoreModel(fold.train, fold.test, ["listener.sourceCountAtDecision"]);
        scored.deployerContext = "recorded separately; not a Model C score";
        scored.deployerCoverage = fold.train.filter((row) => finite(row.deployerEvidenceN) != null).length;
        if (extra && scored.abstainReason && !extra.abstainReason) {
          /* source-only component already in O2; deployer is reported, not used as the score */
        }
      }
      const cohorts = cohortStats(scored.scores || []);
      foldRows.push({
        name: fold.name,
        n: scored.n,
        rhoPnl: scored.rhoPnl,
        rhoMfe: scored.rhoMfe,
        kendall: scored.kendall,
        abstainReason: scored.abstainReason,
        cohorts,
        variation: scored.variation,
      });
    }
    const varying = foldRows.some((fold) => fold.abstainReason == null && fold.n > 0);
    models[model] = { status: varying ? "HOLDOUT_DESCRIPTIVE" : "NO_FEATURE_VARIATION", folds: foldRows };
  }
  const pass = strictPass(models.O1);
  return {
    status: pass.pass ? "PASS_OPPORTUNITY_RESEARCH" : status === "POST_DECISION_SIGNAL_ONLY" ? status : "COLLECT_WALLET_FLOW",
    researchVerdict: pass.pass ? "PASS_OPPORTUNITY_RESEARCH" : status === "POST_DECISION_SIGNAL_ONLY" ? status : "COLLECT_WALLET_FLOW",
    pass: false,
    passGate: pass,
    shadowCanPromoteLive: false,
    liveStatus: "UNCHANGED",
    n: primary.length,
    mayhemN: mayhem.length,
    leadLag: lag,
    models,
    variation: variationOf(primary, ACCESSOR_NAMES),
    postDecisionSignalOnly: status === "POST_DECISION_SIGNAL_ONLY",
  };
}

function strictPass(model) {
  if (!model || !model.folds || model.folds.length < 2) return { pass: false, reason: "need_multiple_folds" };
  const folds = model.folds.filter((fold) => fold.abstainReason == null && fold.n >= 20);
  if (folds.length < 2) return { pass: false, reason: "insufficient_fold_signal" };
  for (const fold of folds) {
    if (!(fold.rhoPnl >= 0.15) || !(fold.rhoMfe >= 0.15)) return { pass: false, reason: "rho_below_gate" };
    const c = fold.cohorts || {};
    if (!(c.top5 && c.baselineMedianPnl != null && c.top5.medianPnl > c.baselineMedianPnl)) return { pass: false, reason: "top_pnl" };
    if (!(c.top5 && c.top5.runner10 != null)) return { pass: false, reason: "runner10" };
    if (!(c.top5 && c.top5.mfe != null)) return { pass: false, reason: "mfe" };
    if (!(c.top5 && c.top5.mae != null)) return { pass: false, reason: "MISSING_MAE_EVIDENCE" };
  }
  return { pass: false, reason: "correlation_alone_is_not_a_pass" };
}

function healthFromBook(book) {
  const rows = buildRows(book);
  const correctedEvents = [...book.events.values()].filter((event) => isCorrectedVersion(event.featureVersion));
  const preFixEvents = [...book.events.values()].filter((event) => event.featureVersion && !isCorrectedVersion(event.featureVersion));
  const correctedLaunches = [...book.launches.values()].filter((row) => isCorrectedVersion(row.featureVersion));
  const deduped = correctedEvents.length;
  let leakageViolations = 0;
  for (const row of rows) {
    for (const windowMs of DECISION_WINDOWS) {
      const snap = row["walletFlow" + windowMs];
      if (snap && snap.decisionEligible && finite(snap.lastIncludedObservedAt) != null && snap.lastIncludedObservedAt > row.decisionCutoffAt) {
        leakageViolations++;
      }
    }
  }
  function windowHealth(windowMs) {
    const snaps = rows.map((row) => row["walletFlow" + windowMs]).filter(Boolean);
    const values = snaps.map((snap) => snap.uniqueNonCreatorBuyers);
    const eligible = snaps.filter((snap) => snap.decisionEligible).length;
    return {
      launchesWithIndependentFlow: snaps.filter((snap) => snap.uniqueNonCreatorBuyers > 0).length,
      decisionEligible: eligible,
      uniqueValueCount: new Set(values).size,
      independentFlowCoverage: eligible ? snaps.filter((snap) => snap.decisionEligible && snap.uniqueNonCreatorBuyers > 0).length / eligible : 0,
      grossBuySol: snaps.filter((snap) => snap.grossBuySol != null).length,
      netBuySol: snaps.filter((snap) => snap.netBuySol != null).length,
      topBuyerShare: snaps.filter((snap) => snap.topBuyerShare != null).length,
      creatorShareOfBuyFlow: snaps.filter((snap) => snap.creatorShareOfBuyFlow != null).length,
    };
  }
  let creatorOnly = 0;
  let nonCreator = 0;
  const buys = correctedEvents.filter((event) => event.side === "buy" && !event.inCreateTransaction);
  for (const event of correctedEvents) {
    if (event.side !== "buy") continue;
    if (event.inCreateTransaction) creatorOnly++;
    else nonCreator++;
  }
  const late = correctedEvents.filter((event) => {
    const launch = book.launches.get(launchKey(event.mint));
    return launch && finite(launch.decisionCutoffAt) != null && event.observedAt > launch.decisionCutoffAt && !event.inCreateTransaction;
  }).length;
  const boundary = correctedLaunches.reduce((min, row) => {
    const t = finite(row.firstObservedAt);
    if (t == null) return min;
    return min == null ? t : Math.min(min, t);
  }, null);
  const sourceNames = ["helius_preprocessed", "helius_processed", "geyser", "logs"];
  const sourceCoverage = {};
  for (const name of sourceNames) {
    sourceCoverage[name] = correctedEvents.filter((event) => event.sources && event.sources[name] != null).length;
  }
  let quoteRawPresent = 0;
  let quoteAmountResolved = 0;
  let solAmountResolved = 0;
  let customQuoteRaw = 0;
  let unknownAmount = 0;
  for (const event of correctedEvents) {
    const hasRaw = rawInt(event.quoteRaw) != null;
    const hasAmount = finite(event.quoteAmount) != null || finite(event.wireSol) != null;
    if (hasRaw) quoteRawPresent++;
    if (hasAmount || hasRaw) quoteAmountResolved++;
    const sol = quoteIsSol(event.quoteMint) && (finite(event.quoteAmount) != null || finite(event.wireSol) != null || hasRaw);
    if (sol) solAmountResolved++;
    if (event.quoteMint && !quoteIsSol(event.quoteMint) && hasRaw) customQuoteRaw++;
    if (!hasRaw && !hasAmount) unknownAmount++;
  }
  let walletPresent = 0;
  let creatorWallet = 0;
  let deployerWallet = 0;
  let nonCreatorWallet = 0;
  for (const event of buys) {
    if (!event.wallet) continue;
    walletPresent++;
    if (event.isCreator === true) creatorWallet++;
    else if (event.isDeployer === true) deployerWallet++;
    else nonCreatorWallet++;
  }
  const correctedObservations = book.correctedObservations || deduped;
  return {
    epoch: RESEARCH_EPOCH,
    featureVersion: FEATURE_VERSION,
    collectorFixVersion: COLLECTOR_FIX_VERSION,
    priorFeatureVersion: PRIOR_FEATURE_VERSION,
    priorEpochUnchanged: PRIOR_EPOCH,
    correctedBoundaryAt: boundary,
    launches: correctedLaunches.length,
    preFixExcludedLaunches: [...book.launches.values()].filter((row) => row.featureVersion && !isCorrectedVersion(row.featureVersion)).length,
    preFixExcludedEvents: preFixEvents.length,
    flowTxObserved: correctedObservations,
    dedupedTransactions: deduped,
    sourceMerges: Math.max(0, correctedObservations - deduped),
    w100: windowHealth(100),
    w250: windowHealth(250),
    w500: windowHealth(500),
    creatorOnlyFlow: creatorOnly,
    nonCreatorFlow: nonCreator,
    walletHistoryCoverage: rows.filter((row) => row.walletFlow250 && row.walletFlow250.experiencedWalletCount != null).length,
    lateOnlyFlow: late,
    leakageViolations,
    sourceCoverage,
    sourceOverlap: correctedEvents.filter((event) => event.sourceCount > 1).length,
    walletResolvedRate: buys.length ? walletPresent / buys.length : 0,
    amountResolvedRate: correctedEvents.length ? (correctedEvents.length - unknownAmount) / correctedEvents.length : 0,
    flowAmountQuality: {
      events_total: correctedEvents.length,
      quote_raw_present: quoteRawPresent,
      quote_amount_resolved: quoteAmountResolved,
      sol_amount_resolved: solAmountResolved,
      custom_quote_raw_present: customQuoteRaw,
      unknown_amount: unknownAmount,
    },
    walletResolution: {
      flow_buys: buys.length,
      wallet_present: walletPresent,
      wallet_missing: buys.length - walletPresent,
      creator_wallet: creatorWallet,
      deployer_wallet: deployerWallet,
      non_creator_wallet: nonCreatorWallet,
    },
  };
}

function ingestRecord(book, row) {
  if (!row || typeof row !== "object") return;
  if (row.type === "wallet_flow_launch") {
    noteCandidate(book, row);
    const launch = book.launches.get(launchKey(row.mint));
    if (!launch) return;
    if (launch.decisionCutoffAt == null && finite(row.decisionCutoffAt) != null) launch.decisionCutoffAt = row.decisionCutoffAt;
    if (finite(row.firstObservedAt) != null) {
      launch.firstObservedAt = Math.min(launch.firstObservedAt || row.firstObservedAt, row.firstObservedAt);
    }
    if (row.creator) launch.creator = launch.creator || row.creator;
    if (row.deployer) launch.deployer = launch.deployer || row.deployer;
    if (row.quoteMint) launch.quoteMint = launch.quoteMint || row.quoteMint;
    if (row.mayhem === true) launch.mayhem = true;
    if (row.sourceCountAtDecision != null) launch.sourceCountAtDecision = row.sourceCountAtDecision;
    if (row.deployerEvidenceN != null) launch.deployerEvidenceN = row.deployerEvidenceN;
    if (row.pnl != null) launch.pnl = row.pnl;
    if (row.mfe != null) launch.mfe = row.mfe;
    if (row.mae != null) launch.mae = row.mae;
    if (row.runner10 != null) launch.runner10 = row.runner10;
    if (row.outcomeObservedAt != null) launch.outcomeObservedAt = row.outcomeObservedAt;
    return;
  }
  if (row.type === "wallet_flow_event" || (row.type === "wallet_flow_source" && row.side)) {
    observeFlow(book, row);
    return;
  }
  if (row.type === "wallet_flow_source") {
    book.rawObservations = (book.rawObservations || 0) + 1;
    if (!row.txSignature) return;
    for (const event of book.events.values()) {
      if (event.txSignature === row.txSignature && event.mint === row.mint) {
        mergeSource(event, row);
        if (isCorrectedVersion(event.featureVersion)) book.correctedObservations = (book.correctedObservations || 0) + 1;
        break;
      }
    }
    return;
  }
  if (row.type === "wallet_flow_outcome") {
    const launch = book.launches.get(launchKey(row.mint));
    if (!launch || !isCorrectedVersion(launch.featureVersion)) return;
    if (row.decisionCutoffAt != null && launch.decisionCutoffAt != null && row.decisionCutoffAt !== launch.decisionCutoffAt) return;
    launch.pnl = row.pnl;
    launch.mfe = row.mfe;
    launch.mae = row.mae;
    launch.runner10 = row.runner10;
    launch.outcomeObservedAt = row.outcomeObservedAt;
  }
}

module.exports = {
  FEATURE_VERSION,
  PRIOR_FEATURE_VERSION,
  COLLECTOR_FIX_VERSION,
  RESEARCH_EPOCH,
  PRIOR_EPOCH,
  SOL_MINT,
  USDC_MINT,
  DECISION_WINDOWS,
  DESCRIPTIVE_WINDOWS,
  MIN_EFFECTIVE_N,
  O1_FEATURES,
  ACCESSOR_NAMES,
  TRADE_DISC,
  emptyBook,
  noteCandidate,
  noteDecision,
  observeFlow,
  parseTradeEventLog,
  flowFromBuyInstruction,
  snapshotWindow,
  buildRows,
  featureValue,
  variationOf,
  scoreModel,
  walkFolds,
  assertTemporal,
  leadLag,
  evaluateBook,
  strictPass,
  healthFromBook,
  ingestRecord,
  amountForLaunch,
};
