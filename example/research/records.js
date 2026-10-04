/**
 * Build decision-time SelectionResearchRecords from jsonl traces.
 * Never backfills decision features from later information.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { num } = require("./math");
const {
  RESEARCH_EPOCH,
  MODEL_VERSION,
  FEATURE_VERSION,
  STATE_FIX_VERSION,
  PERCENTILE_WINDOW_VERSION,
  OUTCOME_STATUS,
} = require("./promotion-protocol");

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function segmentOf(row) {
  if (row.sampleSegment === "post_fix") return "post_fix";
  if (row.sampleSegment === "pre_fix") return "pre_fix";
  if (row.stateFixVersion === STATE_FIX_VERSION) return "post_fix";
  if (row.researchEpoch === RESEARCH_EPOCH) return "post_fix";
  return "pre_fix";
}

function researchIdentity(row) {
  // Prefer createSig+mint; fall back to mint+decision+ts
  const mint = row.mint || "";
  const sig = row.createSig || row.createSignature || "";
  const dec = row.decision || "";
  const ts = row.ts || row.decisionAt || 0;
  return `${mint}|${sig}|${dec}|${ts}`;
}

function knownAtDecision(row) {
  return (
    row.deployerPreviouslyProfitable > 0 ||
    (typeof row.deployerN === "number" && row.deployerN >= 1) ||
    row.boughtDeployerBefore === true ||
    row.knownAtDecision === true
  );
}

/**
 * Classify outcome completeness. Never coerce missing → 0.
 */
function classifyOutcome(decision, exit) {
  if (!exit && decision.decision !== "buy") {
    // Unselected / skip — no trade outcome required for ranking of selected path,
    // but counterfactual fields may exist.
    if (
      typeof decision.ret30s === "number" ||
      typeof decision.mfe30s === "number"
    ) {
      return {
        status: OUTCOME_STATUS.COMPLETE,
        realizedPnl: num(decision.ret30s),
        execMfe: num(decision.mfe30s),
        execMae: num(decision.mae30s),
        win: typeof decision.ret30s === "number" ? decision.ret30s > 0 : null,
        stopLoss: false,
        maxHold: false,
        exitReason: "counterfactual",
        horizonMs: 30000,
        complete: true,
      };
    }
    return { status: OUTCOME_STATUS.MISSING, complete: false };
  }
  if (decision.decision === "buy" && !exit) {
    return {
      status: OUTCOME_STATUS.CENSORED,
      realizedPnl: null,
      execMfe: null,
      execMae: null,
      win: null,
      stopLoss: false,
      maxHold: false,
      exitReason: null,
      horizonMs: null,
      complete: false,
    };
  }
  const pnl = num(exit.pnlPct);
  const mfe = num(exit.executableMfePct);
  const mae = num(exit.executableMaePct);
  // Prefer executable; never fall back to legacy unit-price mfe/mae for training
  if (pnl == null && mfe == null) {
    return { status: OUTCOME_STATUS.INVALID, complete: false };
  }
  const reason = exit.exitReason || "";
  return {
    status: OUTCOME_STATUS.COMPLETE,
    realizedPnl: pnl,
    execMfe: mfe,
    execMae: mae,
    win: pnl != null ? pnl > 0 : null,
    stopLoss: /^SL_/i.test(reason),
    maxHold: reason === "MAX_HOLD",
    exitReason: reason || null,
    horizonMs: typeof exit.holdMs === "number" ? exit.holdMs : null,
    complete: true,
  };
}

/**
 * Leakage heuristics on a decision-time record.
 */
function detectLeakage(row) {
  const reasons = [];
  // Exit fields must not appear as entry features
  if (row.exitReason && row.decision === "buy" && !row.outcome) {
    // exitReason on decision without nested outcome is suspicious only if
    // it was used as a feature — we flag if present at top-level alongside
    // selectionScore mutation markers
  }
  if (
    typeof row.postEntryLiquidity === "number" ||
    typeof row.futureDeployerPnl === "number"
  ) {
    reasons.push("future_fields_on_decision");
  }
  if (row.convictionScoreUpdatedAfterExit === true) {
    reasons.push("conviction_mutated_after_exit");
  }
  if (row.lookahead === true || row.leaked === true) {
    reasons.push("explicit_leak_flag");
  }
  return reasons;
}

function toResearchRecord(decision, exit) {
  const outcome = classifyOutcome(decision, exit);
  const conv =
    num(decision.globalConvPct, decision.convictionPct, decision.percentileAtDecision) ??
    null;
  const softFloor = num(
    decision.effectiveScore,
    decision.creatorScore,
    decision.admissionScore,
    decision.softFloorScore
  );
  const rankScore = num(decision.rankScore, conv, softFloor);
  const segment = segmentOf(decision);
  const leak = detectLeakage(decision);

  return {
    candidateId: researchIdentity(decision),
    mint: decision.mint || null,
    deployer: decision.deployer || decision.creator || null,
    detectedAt: num(decision.detectedAt, decision.ts) ?? null,
    decisionAt: num(decision.decisionAt, decision.ts) ?? null,
    modelVersion: decision.modelVersion || MODEL_VERSION,
    featureVersion: decision.featureVersion || FEATURE_VERSION,
    stateFixVersion: decision.stateFixVersion || null,
    percentileWindowVersion: decision.percentileWindowVersion || null,
    researchEpoch:
      decision.researchEpoch ||
      (segment === "post_fix" ? RESEARCH_EPOCH : "pre_fix"),
    sampleSegment: segment,
    convictionScore: conv,
    rankScore,
    softFloorScore: softFloor,
    deployerScore: num(decision.deployerScore) ?? null,
    selected: decision.decision === "buy",
    selectionReason:
      decision.decision === "buy"
        ? "buy"
        : decision.skipReason || "skip",
    knownAtDecision: knownAtDecision(decision),
    convictionWindowN: num(decision.globalConvN, decision.convictionWindowN) ?? 0,
    rankAtDecision: num(decision.rankAtDecision) ?? null,
    percentileAtDecision: conv,
    execution: {
      attempted: decision.decision === "buy",
      submitted: decision.decision === "buy",
      abortReason: null,
      slotDelta: num(exit?.slotDelta, decision.slotDelta),
    },
    outcome: outcome.complete
      ? {
          status: outcome.status,
          realizedPnl: outcome.realizedPnl,
          execMfe: outcome.execMfe,
          execMae: outcome.execMae,
          win: outcome.win,
          stopLoss: outcome.stopLoss,
          maxHold: outcome.maxHold,
          exitReason: outcome.exitReason,
          horizonMs: outcome.horizonMs,
          complete: true,
        }
      : {
          status: outcome.status,
          realizedPnl: null,
          execMfe: null,
          execMae: null,
          win: null,
          stopLoss: false,
          maxHold: false,
          exitReason: outcome.exitReason || null,
          horizonMs: null,
          complete: false,
        },
    leakageReasons: leak,
  };
}

/**
 * Load and join decision + exit traces into research records.
 */
function buildRecords({ decisionPath, exitPath, epochOnly = RESEARCH_EPOCH } = {}) {
  const decisions = loadJsonl(decisionPath);
  const exits = loadJsonl(exitPath);
  const exitByMint = new Map();
  for (const e of exits) {
    if (!e.mint) continue;
    // Prefer post_fix stamped exits when duplicates exist
    const prev = exitByMint.get(e.mint);
    if (!prev || (e.sampleSegment === "post_fix" && prev.sampleSegment !== "post_fix")) {
      exitByMint.set(e.mint, e);
    }
  }

  const raw = [];
  for (const d of decisions) {
    if (!d.mint) continue;
    // Prefer buy rows; also keep skip|outcome counterfactuals
    const isBuy = d.decision === "buy";
    const isCf =
      typeof d.skipReason === "string" && d.skipReason.includes("|outcome");
    if (!isBuy && !isCf) {
      // Still record skips for survivor-bias analysis when they carry scores
      if (d.globalConvPct == null && d.convictionPct == null && d.creatorScore == null) {
        continue;
      }
    }
    const ex = isBuy ? exitByMint.get(d.mint) : null;
    raw.push(toResearchRecord(d, ex));
  }
  return { raw, decisions: decisions.length, exits: exits.length };
}

function defaultPaths() {
  // example/research → ../../../wallets (solana-ops/wallets)
  const wallets = path.join(__dirname, "..", "..", "..", "wallets");
  return {
    decisionPath: path.join(wallets, "decision-traces.jsonl"),
    exitPath: path.join(wallets, "exit-traces.jsonl"),
    reportDir: path.join(__dirname, "..", "..", "reports", "promotion"),
  };
}

module.exports = {
  loadJsonl,
  segmentOf,
  researchIdentity,
  classifyOutcome,
  detectLeakage,
  toResearchRecord,
  buildRecords,
  defaultPaths,
  STATE_FIX_VERSION,
  PERCENTILE_WINDOW_VERSION,
};
