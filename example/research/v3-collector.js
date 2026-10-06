/**
 * Telemetry-only V3 decision stamp.
 * Called after the frozen listener decision. It does not return a buy, a fee,
 * or a kill. Opportunity stays abstained until a real decision-time feature
 * family exists at scale.
 *
 * Optional sensors (geyser / logs / blocks) are NOT_CONFIGURED unless a source
 * event actually arrives. Helius preprocessed and processed are the live feeds.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { classifyQuote, SOL_MINT } = require("./observation/canonical");

const V3_EPOCH = "selection_v3_shadow_2026_10";
const V3_MODEL = "selection-v3-shadow";
const COLLECTOR_VERSION = "v3-collector-1";
const SOURCE_MAP = {
  preprocessed: "helius_preprocessed",
  txsub: "helius_processed",
  geyser: "geyser",
  logs: "logs",
  blocks: "blocks",
};

const byMint = new Map();
let startedAt = null;
let bannerPrinted = false;
let tracePath = null;
let curveFetcher = null;

function defaultTracePath() {
  return path.join(__dirname, "..", "..", "..", "wallets", "v3-decisions.jsonl");
}

function traceFile() {
  return tracePath || defaultTracePath();
}

function setTracePath(p) {
  tracePath = p;
}

function attachCurveFetcher(fn) {
  curveFetcher = typeof fn === "function" ? fn : null;
}

function banner() {
  if (bannerPrinted) return;
  bannerPrinted = true;
  startedAt = Date.now();
  console.log("[V3] epoch=" + V3_EPOCH);
  console.log("[V3] mode=SHADOW_OBSERVE_ONLY");
  console.log("[V3] executionImpact=NONE");
  console.log("[V3] risk=research_only");
  console.log("[V3] opportunity=collecting");
  console.log("[V3] sensor_status geyser=NOT_CONFIGURED logs=NOT_CONFIGURED blocks=NOT_CONFIGURED");
}

function append(row) {
  const file = traceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

function mapSource(source) {
  if (!source) return "other";
  return SOURCE_MAP[source] || source;
}

function bucket(mint) {
  let rec = byMint.get(mint);
  if (!rec) {
    rec = { sources: [], meta: {}, decision: null, late: [], flow: [] };
    byMint.set(mint, rec);
  }
  return rec;
}

function noteSource(event) {
  banner();
  if (!event || !event.mint) return null;
  const rec = bucket(event.mint);
  const observedAt = typeof event.observedAt === "number" ? event.observedAt : Date.now();
  const src = {
    source: mapSource(event.source),
    observedAt,
    slot: event.slot ?? null,
  };
  if (event.creator && !rec.meta.creator) {
    rec.meta.creator = event.creator;
    rec.meta.creatorSource = event.creatorSource || "create_event";
  } else if (event.creator && rec.meta.creator && event.creator !== rec.meta.creator) {
    rec.meta.fieldConflict = rec.meta.fieldConflict || [];
    rec.meta.fieldConflict.push({ field: "creator", values: [rec.meta.creator, event.creator] });
  }
  if (event.quoteMint && !rec.meta.quoteMint) {
    rec.meta.quoteMint = event.quoteMint;
    rec.meta.quoteMintSource = event.quoteMintSource || null;
  } else if (event.quoteMint && rec.meta.quoteMint && event.quoteMint !== rec.meta.quoteMint) {
    rec.meta.fieldConflict = rec.meta.fieldConflict || [];
    rec.meta.fieldConflict.push({ field: "quoteMint", values: [rec.meta.quoteMint, event.quoteMint] });
  }
  if (event.deployer) rec.meta.deployer = rec.meta.deployer || event.deployer;
  if (event.createVersion) rec.meta.createVersion = rec.meta.createVersion || event.createVersion;
  if (event.mayhem != null) rec.meta.mayhem = event.mayhem;
  if (event.cashback != null) rec.meta.cashback = event.cashback;
  if (event.bondingCurve) rec.meta.bondingCurve = event.bondingCurve;
  if (event.tokenProgram) rec.meta.tokenProgram = event.tokenProgram;
  if (event.createSignature) rec.meta.createSignature = rec.meta.createSignature || event.createSignature;

  if (rec.decision && observedAt > rec.decision.decisionCutoffAt) {
    const late = { ...src, afterDecision: true, decisionCutoffAt: rec.decision.decisionCutoffAt };
    rec.late.push(late);
    append({
      type: "v3_source_late",
      mint: event.mint,
      researchEpoch: V3_EPOCH,
      ...late,
    });
    return late;
  }
  rec.sources.push(src);
  return { ...src, afterDecision: false };
}

function flowFromDecision(trace, cutoff) {
  if (trace.sameTxCreatorBuy !== true || typeof trace.creatorBuySol !== "number") {
    return {
      windowMs: 500,
      uniqueBuyers: null,
      buyCount: null,
      buySol: null,
      lastIncludedObservedAt: null,
      decisionEligible: false,
    };
  }
  return {
    windowMs: 500,
    uniqueBuyers: 1,
    buyCount: 1,
    buySol: trace.creatorBuySol,
    medianBuySol: trace.creatorBuySol,
    maxBuySol: trace.creatorBuySol,
    creatorBought: true,
    creatorBuySol: trace.creatorBuySol,
    topBuyerShare: 1,
    lastIncludedObservedAt: cutoff,
    decisionEligible: true,
    source: "create_tx",
  };
}

function isOutcomeRow(trace) {
  return typeof trace.skipReason === "string" && trace.skipReason.includes("|outcome");
}

function observeDecision(trace) {
  banner();
  if (!trace || !trace.mint) return null;
  const rec = bucket(trace.mint);
  if (isOutcomeRow(trace)) {
    const outcome = {
      type: "v3_outcome",
      mint: trace.mint,
      researchEpoch: V3_EPOCH,
      createSignature: (rec.decision && rec.decision.createSignature) || rec.meta.createSignature || null,
      decisionCutoffAt: rec.decision ? rec.decision.decisionCutoffAt : null,
      pnl: typeof trace.ret30s === "number" ? trace.ret30s : null,
      mfe: typeof trace.mfe30s === "number" ? trace.mfe30s : null,
      mae: typeof trace.mae30s === "number" ? trace.mae30s : null,
      runner10: typeof trace.mfe30s === "number" ? trace.mfe30s >= 10 : null,
      valuationSource: trace.executableShadow ? "pump_curve" : "single_source",
      confidence: trace.executableShadow ? 0.6 : 0.4,
      afterDecision: true,
    };
    append(outcome);
    return outcome;
  }
  if (rec.decision) return rec.decision;

  const cutoff = typeof trace.ts === "number" ? trace.ts : Date.now();
  const sources = rec.sources.filter((s) => typeof s.observedAt === "number" && s.observedAt <= cutoff);
  const mapped = mapSource(trace.source);
  if (mapped && mapped !== "other" && !sources.some((s) => s.source === mapped)) {
    sources.push({ source: mapped, observedAt: cutoff, slot: trace.createSlot ?? null });
  }
  const pre = sources.find((s) => s.source === "helius_preprocessed");
  const processed = sources.find((s) => s.source === "helius_processed");
  const quoteMint = rec.meta.quoteMint || null;
  const quote = classifyQuote({ quoteMint: quoteMint || (trace.buyFamily === "SOL_EXACT" ? SOL_MINT : null) });
  const slots = sources.map((s) => s.slot).filter((s) => typeof s === "number");
  const flow = flowFromDecision(trace, cutoff);
  const leakageViolations = sources.filter((s) => s.observedAt > cutoff).length;
  const snap = {
    type: "v3_decision",
    researchEpoch: V3_EPOCH,
    oldResearchEpoch: "post_fix_v1",
    oldModelVersion: "deployer85-shrink-v1",
    v2ModelVersion: "selection-v2-shadow",
    v3ModelVersion: V3_MODEL,
    v3CollectorVersion: COLLECTOR_VERSION,
    v3CollectorStartedAt: startedAt,
    executionImpact: "none",
    maySubmit: false,
    mint: trace.mint,
    createSignature: trace.createSig || rec.meta.createSignature || null,
    firstObservedAt: sources.length ? Math.min(...sources.map((s) => s.observedAt)) : cutoff,
    decisionCutoffAt: cutoff,
    decisionTimestamp: cutoff,
    firstSlot: slots.length ? slots[0] : trace.createSlot ?? null,
    decisionSlot: trace.createSlot ?? null,
    sourceTags: sources.map((s) => s.source),
    firstSource: sources[0] ? sources[0].source : mapped,
    sourceCount: sources.length,
    sourceAgreement: !(rec.meta.fieldConflict && rec.meta.fieldConflict.length),
    sourceCountAtDecision: sources.length,
    sourceAgreementAtDecision: !(rec.meta.fieldConflict && rec.meta.fieldConflict.length),
    preSeen: !!pre,
    processedSeen: !!processed,
    preObservedAt: pre ? pre.observedAt : null,
    processedObservedAt: processed ? processed.observedAt : null,
    preToProcessedMs: pre && processed ? processed.observedAt - pre.observedAt : null,
    slotDifference:
      slots.length >= 2 ? Math.max(...slots) - Math.min(...slots) : null,
    creator: trace.creator || rec.meta.creator || null,
    creatorSource: rec.meta.creatorSource || (trace.creator ? "create_event" : null),
    deployer: trace.deployer || rec.meta.deployer || null,
    quoteMint: quote.quoteMint,
    quoteAssetClass: quote.quoteAssetClass,
    isCustomPair: quote.isCustomPair,
    quoteMintSource: rec.meta.quoteMintSource || (quote.quoteMint ? "decision_trace" : null),
    createVersion: rec.meta.createVersion || "unknown",
    mayhem: trace.mayhem === true || rec.meta.mayhem === true,
    cashback: rec.meta.cashback === true || trace.holderReward === true,
    creatorSol: typeof trace.creatorSol === "number" ? trace.creatorSol : null,
    creatorBuySol: typeof trace.creatorBuySol === "number" ? trace.creatorBuySol : null,
    deployerRawQuality: typeof trace.rawScore === "number" ? trace.rawScore : null,
    deployerEvidenceN: typeof trace.deployerN === "number" ? trace.deployerN : null,
    deployerConfidence: typeof trace.confidence === "number" ? trace.confidence : null,
    riskScore: null,
    riskConfidence: 0,
    riskComponents: {
      mayhem: trace.mayhem === true ? 1 : 0,
      creatorBuySol: typeof trace.creatorBuySol === "number" ? trace.creatorBuySol : null,
      deployerN: typeof trace.deployerN === "number" ? trace.deployerN : null,
      rawScore: typeof trace.rawScore === "number" ? trace.rawScore : null,
    },
    opportunityScore: null,
    opportunityConfidence: 0,
    abstainReason: "insufficient_v3_features",
    walletFlow: flow,
    fieldConflict: rec.meta.fieldConflict || [],
    leakageViolations,
  };
  rec.decision = snap;
  append(snap);
  if (curveFetcher && rec.meta.bondingCurve && !rec.curveScheduled) {
    rec.curveScheduled = true;
    const mint = trace.mint;
    const curveAddr = rec.meta.bondingCurve;
    setImmediate(() => {
      Promise.resolve()
        .then(() => curveFetcher(curveAddr))
        .then((state) => {
          if (!state) return;
          noteCurveObservation({ mint, observedAt: Date.now(), ...state, source: "rpc_account" });
        })
        .catch(() => {});
    });
  }
  return snap;
}

function noteCurveObservation(event) {
  banner();
  if (!event || !event.mint) return null;
  const rec = bucket(event.mint);
  const cutoff = rec.decision ? rec.decision.decisionCutoffAt : null;
  const observedAt = event.observedAt;
  const afterDecision = !(typeof cutoff === "number" && typeof observedAt === "number" && observedAt <= cutoff);
  const row = {
    type: "v3_curve",
    mint: event.mint,
    researchEpoch: V3_EPOCH,
    observedAt,
    afterDecision,
    decisionEligible: !afterDecision,
    virtualSolReserves: event.virtualSolReserves ?? null,
    virtualTokenReserves: event.virtualTokenReserves ?? null,
    realSolReserves: event.realSolReserves ?? null,
    realTokenReserves: event.realTokenReserves ?? null,
    curveProgress: event.curveProgress ?? null,
    spotPrice: event.spotPrice ?? null,
    source: event.source || "rpc_account",
  };
  append(row);
  return row;
}

function resetForTests() {
  byMint.clear();
  startedAt = null;
  bannerPrinted = false;
}

function executionSurface() {
  return { maySubmit: false, executionImpact: "none" };
}

module.exports = {
  V3_EPOCH,
  V3_MODEL,
  COLLECTOR_VERSION,
  noteSource,
  observeDecision,
  noteCurveObservation,
  flowFromDecision,
  setTracePath,
  attachCurveFetcher,
  resetForTests,
  executionSurface,
  defaultTracePath,
};
