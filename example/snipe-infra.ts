/**
 * Snipe infra: traces, MFE/MAE, Helius Sender, preprocessed decode helpers.
 */
import fs from "fs";
import path from "path";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
  Commitment,
  Finality,
} from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "../src/types";
import {
  buildVersionedTx,
  DEFAULT_COMMITMENT,
  DEFAULT_FINALITY,
  getTxDetails,
} from "../src/util";

export type TraceSource =
  | "preprocessed"
  | "txsub"
  | "geyser"
  | "logs";

export type TraceResult =
  | "ok"
  | "2006"
  | "6002"
  | "graduated"
  | "auth"
  | "blockhash"
  | "transport"
  | "other"
  | "skipped"
  /** Freshness invariant aborted retry — state-machine success, not a trade fail */
  | "abort_stale";

/** Frozen research bookkeeping — stamp every decision/exit row */
export const RESEARCH = {
  modelVersion: "deployer85-shrink-v1",
  stateFixVersion: "2026-10-04-mfe-stale-cdf",
  percentileWindowVersion: "empirical-cdf-v1",
  sampleSegment: "post_fix" as const,
  /** Cohorts cannot enter promotion logic below this empirical CDF denominator */
  minPromotionConvN: Number(process.env.SNIPE_MIN_PROMOTION_CONV_N || "100"),
};

export type ResearchMeta = {
  modelVersion: string;
  stateFixVersion: string;
  percentileWindowVersion: string;
  sampleSegment: "pre_fix" | "post_fix";
  globalConvN?: number;
  eligibleConvN?: number;
};

export function stampResearchMeta<T extends object>(
  row: T,
  extra?: Partial<ResearchMeta>
): T & ResearchMeta {
  return {
    ...row,
    modelVersion: RESEARCH.modelVersion,
    stateFixVersion: RESEARCH.stateFixVersion,
    percentileWindowVersion: RESEARCH.percentileWindowVersion,
    sampleSegment: RESEARCH.sampleSegment,
    ...extra,
  };
}

export type AttemptClass = "event" | "rpc_rebuild";
export type SendModeName = "rpc" | "sender_swqos" | "sender_max";

export interface SnipeTrace {
  createSig: string;
  mint: string;
  source: TraceSource;
  createSlot?: number;
  buySlot?: number;
  slotDelta?: number;

  receivedNs: string;
  decodedNs?: string;
  filteredNs?: string;
  builtNs?: string;
  signedNs?: string;
  submittedNs?: string;
  ackNs?: string;

  /** @deprecated alias of receivedNs for older rows */
  detectedNs?: string;
  sendAckNs?: string;

  buySig?: string;
  sendMode: SendModeName;
  attempt: number;
  attemptClass: AttemptClass;
  result: TraceResult;
  priorityFeeLamports: number;
  tipLamports: number;
  err?: string;
  modelVersion?: string;
  stateFixVersion?: string;
  percentileWindowVersion?: string;
  sampleSegment?: "pre_fix" | "post_fix";
}

export interface ExitTrace {
  mint: string;
  createSig?: string;
  source?: TraceSource;
  createSlot?: number;
  buySlot?: number;
  slotDelta?: number;
  entrySol: number;
  exitSol?: number;
  entryPrice: number;
  maxPrice: number;
  minPrice: number;
  exitPrice?: number;
  exitReason: string;
  timeToMfeMs: number;
  timeToMaeMs: number;
  holdMs: number;
  /** @deprecated unit-price path — do not use for training / dead / promotion */
  legacyMfePct?: number;
  /** @deprecated unit-price path — do not use for training / dead / promotion */
  legacyMaePct?: number;
  /** @deprecated alias of legacyMfePct — analyzers must ignore */
  mfePct?: number;
  /** @deprecated alias of legacyMaePct — analyzers must ignore */
  maePct?: number;
  /** Canonical executable bonding-curve MFE since fill */
  executableMfePct?: number;
  /** Canonical executable bonding-curve MAE since fill */
  executableMaePct?: number;
  pnlPct?: number;
  sendMode?: SendModeName;
  /** Fat-tail marker for promotion/tranche analysis */
  tailEvent?: boolean;
  /** Shadow tranche recipes — totals in executable SOL */
  trancheRecipes?: Record<
    string,
    { hits: number; totalSol: number; runnerSol: number; legs: number[] }
  >;
  modelVersion?: string;
  stateFixVersion?: string;
  percentileWindowVersion?: string;
  sampleSegment?: "pre_fix" | "post_fix";
}

const TRACE_DIR = path.join(__dirname, "../../wallets");
const SNIPE_TRACE_PATH = path.join(TRACE_DIR, "snipe-traces.jsonl");
const EXIT_TRACE_PATH = path.join(TRACE_DIR, "exit-traces.jsonl");

/** In-memory session buffers for live [stats] */
export const sessionSnipeTraces: SnipeTrace[] = [];
export const sessionExitTraces: ExitTrace[] = [];

export function nowNs(): bigint {
  return process.hrtime.bigint();
}

export function nsToMs(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  try {
    return Number(BigInt(b) - BigInt(a)) / 1e6;
  } catch {
    return null;
  }
}

export function percentile(sortedOrNot: number[], p: number): number | null {
  if (!sortedOrNot.length) return null;
  const s = [...sortedOrNot].sort((a, b) => a - b);
  const idx = Math.min(
    s.length - 1,
    Math.max(0, Math.ceil((p / 100) * s.length) - 1)
  );
  return s[idx];
}

export function appendJsonl(file: string, row: object) {
  try {
    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[trace] write fail", (e as Error).message);
  }
}

export function logSnipeTrace(t: SnipeTrace) {
  if (t.createSlot != null && t.buySlot != null && t.slotDelta == null) {
    t.slotDelta = t.buySlot - t.createSlot;
  }
  // back-compat aliases
  if (!t.receivedNs && t.detectedNs) t.receivedNs = t.detectedNs;
  if (!t.ackNs && t.sendAckNs) t.ackNs = t.sendAckNs;
  const stamped = stampResearchMeta(t);
  Object.assign(t, stamped);
  sessionSnipeTraces.push(t);
  appendJsonl(SNIPE_TRACE_PATH, t);
  const d2s = nsToMs(t.receivedNs, t.submittedNs);
  const s2a = nsToMs(t.submittedNs, t.ackNs);
  console.log(
    `[trace] ${t.source} mint=${t.mint.slice(0, 8)}… attempt=${t.attempt}/${t.attemptClass} result=${t.result} send=${t.sendMode}` +
      (t.buySig ? ` buy=${t.buySig.slice(0, 8)}…` : "") +
      (t.slotDelta != null ? ` slotΔ=${t.slotDelta}` : "") +
      (d2s != null ? ` d→s=${d2s.toFixed(1)}ms` : "") +
      (s2a != null ? ` s→a=${s2a.toFixed(1)}ms` : "")
  );
}

export function logExitTrace(t: ExitTrace) {
  const stamped = stampResearchMeta(t);
  Object.assign(t, stamped);
  sessionExitTraces.push(t);
  appendJsonl(EXIT_TRACE_PATH, t);
  const execMfe = t.executableMfePct;
  const execMae = t.executableMaePct;
  console.log(
    `[exit:exec] mint=${t.mint.slice(0, 8)}… reason=${t.exitReason}` +
      ` execMFE=${execMfe != null ? execMfe.toFixed(1) : "n/a"}%` +
      ` execMAE=${execMae != null ? execMae.toFixed(1) : "n/a"}%` +
      ` pnl=${t.pnlPct?.toFixed(1) ?? "n/a"}% hold=${t.holdMs}ms` +
      (t.slotDelta != null ? ` slotΔ=${t.slotDelta}` : "")
  );
}

/** Buy + skip counterfactuals — measure filter opportunity cost */
export interface DecisionTrace {
  mint: string;
  creator: string;
  /** create tx fee-payer / create.user — distinct from declared creator */
  deployer?: string;
  createSig?: string;
  createSlot?: number;
  source?: TraceSource;
  decision: "buy" | "skip";
  skipReason?: string;
  /** @deprecated use effectiveScore — kept for back-compat analyzers */
  creatorScore?: number;
  creatorScoreUnknown?: boolean;
  rawScore?: number;
  effectiveScore?: number;
  confidence?: number;
  creatorN?: number;
  deployerScore?: number;
  deployerN?: number;
  deployerLaunches1h?: number;
  creatorSol?: number;
  mayhem?: boolean;
  nameBlocked?: boolean;
  symbol?: string;
  name?: string;
  /** same-create-tx intent */
  sameTxCreatorBuy?: boolean;
  creatorBuySol?: number;
  creatorBuyBucket?: string;
  cuLimit?: number;
  cuPriceMicroLamports?: number;
  numInstructions?: number;
  numSigners?: number;
  hasAddressLookupTables?: boolean;
  holderReward?: boolean;
  tokenProgram?: string;
  /** EV shadow fields (logged; gate optional) */
  pRunner?: number;
  pAdverse?: number;
  expectedPnl30?: number;
  edgeSol?: number;
  /** Empirical CDF conviction ranks 0..100 (null until window has depth) */
  convictionPct?: number | null;
  globalConvPct?: number | null;
  eligibleConvPct?: number | null;
  shadowTop5?: boolean;
  shadowTop2?: boolean;
  shadowTop1?: boolean;
  shadowTop05?: boolean;
  shadowTop01?: boolean;
  shadowBuySol?: number;
  buyFamily?: string;
  maxSolCost?: string;
  minTokensOut?: string;
  encodedSlippageBps?: number;
  deadAt2s?: boolean;
  deployerLaunchesPerDay?: number;
  secsSincePriorLaunch?: number;
  historicalDevBuyMeanSol?: number;
  deployerPreviouslyProfitable?: number;
  hypotheticalEntryPrice?: number;
  ret5s?: number;
  ret10s?: number;
  ret20s?: number;
  ret30s?: number;
  ret60s?: number;
  mfe30s?: number;
  mae30s?: number;
  mfe60s?: number;
  mae60s?: number;
  graduated?: boolean;
  entryMcSol?: number;
  entryMcUsd?: number;
  ts: number;
  /** Research reproducibility stamps */
  modelVersion?: string;
  stateFixVersion?: string;
  percentileWindowVersion?: string;
  sampleSegment?: "pre_fix" | "post_fix";
  globalConvN?: number;
  eligibleConvN?: number;
  /** live_selected = real buy; shadow = counterfactual path, no trade submitted */
  sampleKind?: "live_selected" | "shadow";
  shadowSample?: boolean;
  /** Distinct skip research cohort (stale_create, kill_gated, …) */
  skipCohort?: string;
  /** Shadow labels used executable getBuyPrice/getSellPrice accounting */
  executableShadow?: boolean;
};

const DECISION_TRACE_PATH = path.join(TRACE_DIR, "decision-traces.jsonl");
export const sessionDecisionTraces: DecisionTrace[] = [];

export function logDecisionTrace(t: DecisionTrace) {
  const stamped = stampResearchMeta(t, {
    globalConvN: t.globalConvN,
    eligibleConvN: t.eligibleConvN,
  });
  Object.assign(t, stamped);
  sessionDecisionTraces.push(t);
  appendJsonl(DECISION_TRACE_PATH, t);
  let v3Snapshot: { sourceCountAtDecision?: number } | null = null;
  try {
    // Research telemetry only. The snapshot must not change buy, fee, exit, or kill.
    v3Snapshot = require("./research/v3-collector.js").observeDecision(t);
  } catch (err) {
    console.warn("[V3] decision stamp failed", (err as Error).message);
  }
  try {
    // Separate telemetry object. Do not write sourceCount back onto the economic trace.
    require("./research/wallet-flow-collector.js").noteDecision({
      ...t,
      sourceCountAtDecision:
        v3Snapshot && typeof v3Snapshot.sourceCountAtDecision === "number"
          ? v3Snapshot.sourceCountAtDecision
          : null,
    });
  } catch (err) {
    console.warn("[wallet-flow] research warning", (err as Error).message);
  }
  try {
    require("./research/timing-frontier-collector.js").noteCutoff({
      mint: t.mint,
      decisionCutoffAt: t.ts,
      creator: t.creator,
      deployer: t.deployer,
      createSig: t.createSig,
      mayhem: t.mayhem === true,
    });
  } catch (err) {
    console.warn("[timing] research warning", (err as Error).message);
  }
  if (t.decision === "skip") {
    console.log(
      `[decision] SKIP ${t.mint.slice(0, 8)}… reason=${t.skipReason} score=${
        t.creatorScore ?? "?"
      } creator=${t.creator.slice(0, 8)}…`
    );
  } else {
    console.log(
      `[decision] BUY  ${t.mint.slice(0, 8)}… score=${t.creatorScore ?? "?"} creator=${t.creator.slice(0, 8)}…`
    );
  }
}

export { DECISION_TRACE_PATH };

export function classifyBuyError(err: unknown): TraceResult {
  const s = JSON.stringify(err ?? "");
  if (/2006|ConstraintSeeds/i.test(s)) return "2006";
  if (/6002|TooMuchSolRequired/i.test(s)) return "6002";
  if (/6005|BondingCurveComplete/i.test(s)) return "graduated";
  if (/6000|NotAuthorized/i.test(s)) return "auth";
  if (/Blockhash|blockhash/i.test(s)) return "blockhash";
  if (/fetch|ECONN|timeout|socket|429/i.test(s)) return "transport";
  return "other";
}

export type ConstraintSeedsAccount =
  | "bondingCurve"
  | "associatedBondingCurve"
  | "creatorVault"
  | "userVolumeAccumulator"
  | "associatedUser"
  | "globalVolumeAccumulator"
  | "feeConfig"
  | "other"
  | "unknown";

/**
 * Classify which PDA/account likely failed ConstraintSeeds (2006).
 * Prefer explicit Left/Right or named account in logs; else heuristic on err text.
 */
export function classifyConstraintSeedsAccount(
  err: unknown
): ConstraintSeedsAccount {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? "");
  if (!/2006|ConstraintSeeds/i.test(s)) return "unknown";
  const checks: [RegExp, ConstraintSeedsAccount][] = [
    [/associated[_ ]?bonding[_ ]?curve|assoc.*bond/i, "associatedBondingCurve"],
    [/bonding[_ ]?curve/i, "bondingCurve"],
    [/creator[_ ]?vault/i, "creatorVault"],
    [/user[_ ]?volume[_ ]?accum/i, "userVolumeAccumulator"],
    [/global[_ ]?volume[_ ]?accum/i, "globalVolumeAccumulator"],
    [/associated[_ ]?user|ata/i, "associatedUser"],
    [/fee[_ ]?config/i, "feeConfig"],
  ];
  for (const [re, name] of checks) {
    if (re.test(s)) return name;
  }
  // Anchor sometimes embeds account index only — mark other for tally
  if (/Left:|Right:|ConstraintSeeds/i.test(s)) return "other";
  return "unknown";
}

export function creatorBuyBucket(sol?: number): string {
  if (sol == null || sol <= 0) return "0";
  if (sol < 0.25) return "0-0.25";
  if (sol < 1) return "0.25-1";
  if (sol < 3) return "1-3";
  return "3+";
}

function fmtP(v: number | null, digits = 1, suffix = ""): string {
  return v == null || Number.isNaN(v) ? "n/a" : v.toFixed(digits) + suffix;
}

/** Live [stats] block: latency + slotΔ + PnL by slotΔ */
export function formatSessionStats(extra?: {
  buyOk?: number;
  buyFail?: number;
  abortStale?: number;
  snipes?: number;
}): string {
  const attempts = sessionSnipeTraces;
  const exits = sessionExitTraces;
  const n = attempts.length;
  const byRes: Record<string, number> = {};
  for (const a of attempts) byRes[a.result] = (byRes[a.result] || 0) + 1;

  const ok = attempts.filter((a) => a.result === "ok" && a.slotDelta != null);
  const slotDeltas = ok.map((a) => a.slotDelta as number);
  const d2s = attempts
    .map((a) => nsToMs(a.receivedNs, a.submittedNs))
    .filter((x): x is number => x != null && x >= 0 && x < 60_000);
  const s2a = attempts
    .map((a) => nsToMs(a.submittedNs, a.ackNs))
    .filter((x): x is number => x != null && x >= 0 && x < 60_000);

  const tipSol =
    attempts.reduce((s, a) => s + (a.tipLamports || 0), 0) / 1e9;
  const priSol =
    attempts.reduce((s, a) => s + (a.priorityFeeLamports || 0), 0) / 1e9;

  const mfe = exits
    .map((e) => e.executableMfePct)
    .filter((x): x is number => typeof x === "number");
  const mae = exits
    .map((e) => e.executableMaePct)
    .filter((x): x is number => typeof x === "number");
  const pnl = exits
    .map((e) => e.pnlPct)
    .filter((x): x is number => typeof x === "number");

  const abortStale = byRes.abort_stale || extra?.abortStale || 0;
  const lines: string[] = [];
  lines.push(
    `[stats] n=${n} buyOK=${byRes.ok || 0} 2006=${byRes["2006"] || 0} 6002=${byRes["6002"] || 0} abort_stale=${abortStale} other=${
      (byRes.other || 0) +
      (byRes.transport || 0) +
      (byRes.blockhash || 0) +
      (byRes.graduated || 0) +
      (byRes.auth || 0)
    } snipes=${extra?.snipes ?? "?"}`
  );
  lines.push(
    `[stats] slotΔ p50=${fmtP(percentile(slotDeltas, 50), 0)} p90=${fmtP(
      percentile(slotDeltas, 90),
      0
    )} detect→submit p50=${fmtP(percentile(d2s, 50), 1, "ms")} submit→ack p50=${fmtP(percentile(s2a, 50), 1, "ms")}`
  );
  lines.push(
    `[stats] fees tipSol=${tipSol.toFixed(5)} priSol≈${priSol.toFixed(
      5
    )} send=${attempts[attempts.length - 1]?.sendMode ?? "?"}`
  );
  if (exits.length) {
    lines.push(
      `[stats] exits=${exits.length} execMFE p50=${fmtP(percentile(mfe, 50))}% execMAE p50=${fmtP(
        percentile(mae, 50)
      )}% pnl p50=${fmtP(percentile(pnl, 50))}% avgPnL=${
        pnl.length
          ? (pnl.reduce((a, b) => a + b, 0) / pnl.length).toFixed(1)
          : "n/a"
      }%`
    );
  }

  // PnL by slotΔ — join exits to last ok attempt for mint
  const okByMint = new Map<string, SnipeTrace>();
  for (const a of ok) okByMint.set(a.mint, a);
  const buckets: Record<string, number[]> = {
    "Δ0": [],
    "Δ1": [],
    "Δ2": [],
    "Δ3+": [],
  };
  for (const e of exits) {
    if (typeof e.pnlPct !== "number") continue;
    const d =
      e.slotDelta != null
        ? e.slotDelta
        : okByMint.get(e.mint)?.slotDelta;
    if (d == null) continue;
    const key = d <= 0 ? "Δ0" : d === 1 ? "Δ1" : d === 2 ? "Δ2" : "Δ3+";
    buckets[key].push(e.pnlPct);
  }
  const bucketLine = Object.entries(buckets)
    .map(([k, arr]) => {
      if (!arr.length) return `${k}: n=0`;
      const wins = arr.filter((p) => p > 0).length;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return `${k}: n=${arr.length} win=${((wins / arr.length) * 100).toFixed(
        0
      )}% avgPnL=${avg.toFixed(1)}%`;
    })
    .join(" | ");
  lines.push(`[stats] PnL by slotΔ  ${bucketLine}`);

  return lines.join("\n");
}

/** Helius Sender tip accounts (mainnet) */
export const SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

export type SendMode = "rpc" | "sender_swqos" | "sender_max";

export function resolveSendMode(): SendMode {
  const m = (process.env.SEND_MODE || "rpc").toLowerCase();
  if (m === "sender_swqos" || m === "swqos") return "sender_swqos";
  if (m === "sender_max" || m === "sender" || m === "max") return "sender_max";
  return "rpc";
}

export function senderTipLamports(mode: SendMode): number {
  if (mode === "sender_max")
    return Number(process.env.SENDER_TIP_LAMPORTS || 1_000_000); // 0.001 SOL
  if (mode === "sender_swqos")
    return Number(process.env.SENDER_TIP_LAMPORTS || 5_000); // 0.000005 SOL
  return 0;
}

export function senderEndpoint(mode: SendMode): string {
  const region = (process.env.SENDER_REGION || "ewr").toLowerCase();
  const base =
    process.env.SENDER_URL ||
    `http://${region}-sender.helius-rpc.com/fast`;
  if (mode === "sender_swqos") {
    return base.includes("?")
      ? `${base}&swqos_only=true`
      : `${base}?swqos_only=true`;
  }
  return base;
}

export function pickTipAccount(): PublicKey {
  const i = Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length);
  return new PublicKey(SENDER_TIP_ACCOUNTS[i]);
}

/**
 * Hot-path send: skipPreflight, maxRetries:0, optional Helius Sender + tip.
 * Retries must rebuild/resign — never resubmit the same signed bytes after on-chain fail.
 */
export async function sendHotTx(
  connection: Connection,
  tx: Transaction,
  payer: PublicKey,
  signers: Keypair[],
  priorityFees?: PriorityFee,
  opts?: {
    mode?: SendMode;
    skipSimulation?: boolean;
    commitment?: Commitment;
    finality?: Finality;
  }
): Promise<TransactionResult & { tipLamports?: number; submittedNs?: string }> {
  const mode = opts?.mode ?? resolveSendMode();
  const tipLamports = senderTipLamports(mode);
  const commitment = opts?.commitment ?? DEFAULT_COMMITMENT;
  const finality = opts?.finality ?? DEFAULT_FINALITY;

  let newTx = new Transaction();
  if (priorityFees) {
    newTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit })
    );
    newTx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFees.unitPrice,
      })
    );
  }
  newTx.add(tx);
  if (tipLamports > 0) {
    newTx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: pickTipAccount(),
        lamports: tipLamports,
      })
    );
  }

  const versionedTx = await buildVersionedTx(
    connection,
    payer,
    newTx,
    commitment
  );
  versionedTx.sign(signers);

  if (!opts?.skipSimulation && mode === "rpc") {
    const sim = await connection.simulateTransaction(versionedTx, undefined);
    if (sim.value.err) {
      return { success: false, error: sim.value.err, tipLamports };
    }
  }

  const submittedNs = nowNs().toString();
  const b64 = Buffer.from(versionedTx.serialize()).toString("base64");

  let sig: string;
  try {
    if (mode === "rpc") {
      sig = await connection.sendRawTransaction(versionedTx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });
    } else {
      const url = senderEndpoint(mode);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now().toString(),
          method: "sendTransaction",
          params: [
            b64,
            { encoding: "base64", skipPreflight: true, maxRetries: 0 },
          ],
        }),
      });
      const json: any = await res.json();
      if (json.error) {
        return {
          success: false,
          error: json.error,
          tipLamports,
          submittedNs,
        };
      }
      sig = json.result;
    }
  } catch (e) {
    return { success: false, error: e, tipLamports, submittedNs };
  }

  console.log(
    `sig: https://solscan.io/tx/${sig} mode=${mode} tip=${tipLamports}`
  );

  try {
    const conf = await connection.confirmTransaction(sig, commitment);
    if (conf.value.err) {
      return {
        success: false,
        error: conf.value.err,
        signature: sig,
        tipLamports,
        submittedNs,
      };
    }
    const st = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    if (st?.value?.[0] && !st.value[0].err) {
      return { success: true, signature: sig, tipLamports, submittedNs };
    }
    const details = await getTxDetails(connection, sig, commitment, finality);
    return {
      success: true,
      signature: sig,
      results: details || undefined,
      tipLamports,
      submittedNs,
    };
  } catch (e) {
    // Sender ack'd — treat as soft success if we got a sig
    return { success: true, signature: sig, tipLamports, submittedNs };
  }
}

/** Pump create / create_v2 discriminators */
export const CREATE_IX_DISC = Buffer.from("181ec828051c0777", "hex");
export const CREATE_V2_IX_DISC = Buffer.from("d6904cec5f8b31b4", "hex");
/** buy / buy_exact_sol_in / buy_v2 */
export const BUY_IX_DISC = Buffer.from("66063d1201daebea", "hex");
export const BUY_EXACT_SOL_IX_DISC = Buffer.from("38fc74089edfcd5f", "hex");
export const BUY_V2_IX_DISC = Buffer.from("b817ee6167c5d33d", "hex");
export const BUY_EXACT_QUOTE_V2_DISC = Buffer.from("c2ab1c46684d5b2f", "hex");

const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111";

function readBorshString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) throw new Error("string OOB");
  return [buf.slice(start, end).toString("utf8"), end];
}

export interface LaunchIntent {
  creatorBuyInCreateTx: boolean;
  creatorBuySol?: number;
  buyFamily?: "TOKEN_EXACT" | "SOL_EXACT" | "UNKNOWN";
  requestedTokens?: string;
  maxSolCost?: string;
  minTokensOut?: string;
  inputSol?: number;
  encodedSlippageBps?: number;
  createInstructionIndex: number;
  buyInstructionIndex?: number;
  cuLimit?: number;
  cuPriceMicroLamports?: number;
  numInstructions: number;
  numSigners: number;
  hasAddressLookupTables: boolean;
  holderReward: boolean;
  deployer: string;
  declaredCreator: string;
}

export type DecodedCreateIx = {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  /** Declared create_v2 creator argument */
  creator: string;
  /** create.user / tx fee-payer — the deployer */
  deployer: string;
  bondingCurve?: string;
  isV2: boolean;
  /** Exact token program from create ix accounts */
  tokenProgram?: string;
  intent?: LaunchIntent;
  createInstructionIndex: number;
};

function parseComputeBudget(
  ixs: { programIdIndex: number; data: Uint8Array }[],
  keys: PublicKey[]
): { cuLimit?: number; cuPriceMicroLamports?: number } {
  let cuLimit: number | undefined;
  let cuPriceMicroLamports: number | undefined;
  for (const ix of ixs) {
    const prog = keys[ix.programIdIndex]?.toBase58();
    if (prog !== COMPUTE_BUDGET_PROGRAM) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 1) continue;
    const tag = data[0];
    // SetComputeUnitLimit = 2, SetComputeUnitPrice = 3
    if (tag === 2 && data.length >= 5) cuLimit = data.readUInt32LE(1);
    if (tag === 3 && data.length >= 9)
      cuPriceMicroLamports = Number(data.readBigUInt64LE(1));
  }
  return { cuLimit, cuPriceMicroLamports };
}

export type BuyIxFamily = "TOKEN_EXACT" | "SOL_EXACT" | "UNKNOWN";

export type DecodedBuyArgs = {
  family: BuyIxFamily;
  discHex: string;
  /** TOKEN_EXACT: desired token amount; SOL_EXACT: unused */
  tokenAmount?: bigint;
  /** TOKEN_EXACT: max SOL willing to pay */
  maxSolCost?: bigint;
  /** SOL_EXACT: spendable SOL / quote in */
  solAmount?: bigint;
  /** SOL_EXACT: min tokens out */
  minTokenOut?: bigint;
  /** Best-effort SOL notional for intent features */
  solNotional?: number;
};

/** Classify Pump buy discriminant into argument-layout family. */
export function classifyBuyIx(
  disc: string | Buffer | Uint8Array
): BuyIxFamily {
  const hex =
    typeof disc === "string"
      ? disc.toLowerCase().replace(/^0x/, "")
      : Buffer.from(disc).toString("hex");
  if (hex === "66063d1201daebea" || hex === "b817ee6167c5d33d") {
    return "TOKEN_EXACT";
  }
  if (hex === "38fc74089edfcd5f" || hex === "c2ab1c46684d5b2f") {
    return "SOL_EXACT";
  }
  return "UNKNOWN";
}

/**
 * Decode buy ix args. TOKEN_EXACT = (token_amount, max_sol_cost);
 * SOL_EXACT = (sol_amount, min_token_out). Field order differs by family.
 */
export function decodeBuyArgs(data: Buffer): DecodedBuyArgs | null {
  if (data.length < 8) return null;
  const disc = data.subarray(0, 8);
  const discHex = disc.toString("hex");
  const family = classifyBuyIx(disc);
  if (family === "UNKNOWN") return null;
  if (data.length < 24) {
    return { family, discHex };
  }
  const a = data.readBigUInt64LE(8);
  const b = data.readBigUInt64LE(16);
  if (family === "TOKEN_EXACT") {
    const solNotional = Number(b) / 1e9;
    return {
      family,
      discHex,
      tokenAmount: a,
      maxSolCost: b,
      // Guard: some txs encode max_sol as u64::MAX ("no cap") — not a real stake
      solNotional:
        Number.isFinite(solNotional) && solNotional > 0 && solNotional <= 500
          ? solNotional
          : undefined,
    };
  }
  const solNotional = Number(a) / 1e9;
  return {
    family,
    discHex,
    solAmount: a,
    minTokenOut: b,
    solNotional:
      Number.isFinite(solNotional) && solNotional > 0 && solNotional <= 500
        ? solNotional
        : undefined,
  };
}

function parseBuySolFromIx(data: Buffer): number | undefined {
  return decodeBuyArgs(data)?.solNotional;
}

function isBuyDisc(disc: Buffer): boolean {
  return classifyBuyIx(disc) !== "UNKNOWN";
}

/**
 * Decode pump create/create_v2 from a signed wire transaction (preprocessed).
 * Also extracts same-tx buy intent + compute budget (zero-wait features).
 */
export function decodeCreateFromWireTx(
  txBytes: Buffer,
  pumpProgram: PublicKey
): DecodedCreateIx | null {
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(txBytes);
  } catch {
    return null;
  }
  const msg = vtx.message;
  const keys = msg.staticAccountKeys;
  const pump = pumpProgram.toBase58();
  const ixs = msg.compiledInstructions;
  const { cuLimit, cuPriceMicroLamports } = parseComputeBudget(ixs, keys);
  const numSigners = msg.header.numRequiredSignatures;
  const hasAddressLookupTables =
    "addressTableLookups" in msg &&
    Array.isArray((msg as any).addressTableLookups) &&
    (msg as any).addressTableLookups.length > 0;

  let createIxIndex = -1;
  let decoded: DecodedCreateIx | null = null;

  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const prog = keys[ix.programIdIndex];
    if (!prog || prog.toBase58() !== pump) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 8) continue;
    const disc = data.subarray(0, 8);
    const isV2 = disc.equals(CREATE_V2_IX_DISC);
    const isV1 = disc.equals(CREATE_IX_DISC);
    if (!isV1 && !isV2) continue;

    try {
      let o = 8;
      let name: string, symbol: string, uri: string;
      [name, o] = readBorshString(data, o);
      [symbol, o] = readBorshString(data, o);
      [uri, o] = readBorshString(data, o);
      let creator: string;
      if (o + 32 <= data.length) {
        creator = new PublicKey(data.subarray(o, o + 32)).toBase58();
      } else {
        creator = keys[0]?.toBase58() || "";
      }
      const mintIdx = ix.accountKeyIndexes[0];
      const curveIdx = ix.accountKeyIndexes[2];
      // IDL: create user=7, create_v2 user=5; token_program create=9 / v2=7
      const userIdx = isV2 ? ix.accountKeyIndexes[5] : ix.accountKeyIndexes[7];
      const tpIdx = isV2 ? ix.accountKeyIndexes[7] : ix.accountKeyIndexes[9];
      const mint = keys[mintIdx]?.toBase58();
      if (!mint) return null;
      const deployer =
        keys[userIdx]?.toBase58() || keys[0]?.toBase58() || creator;
      createIxIndex = i;
      decoded = {
        mint,
        name,
        symbol,
        uri,
        creator,
        deployer,
        bondingCurve: keys[curveIdx]?.toBase58(),
        isV2,
        tokenProgram: keys[tpIdx]?.toBase58(),
        createInstructionIndex: i,
      };
      break;
    } catch {
      continue;
    }
  }
  if (!decoded) return null;

  let buyInstructionIndex: number | undefined;
  let creatorBuySol: number | undefined;
  let buyFamily: LaunchIntent["buyFamily"];
  let requestedTokens: string | undefined;
  let maxSolCost: string | undefined;
  let minTokensOut: string | undefined;
  let inputSol: number | undefined;
  let encodedSlippageBps: number | undefined;
  for (let i = 0; i < ixs.length; i++) {
    if (i === createIxIndex) continue;
    const ix = ixs[i];
    const prog = keys[ix.programIdIndex];
    if (!prog || prog.toBase58() !== pump) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 8) continue;
    const decodedBuy = decodeBuyArgs(data);
    if (!decodedBuy) continue;
    buyInstructionIndex = i;
    buyFamily = decodedBuy.family;
    creatorBuySol = decodedBuy.solNotional;
    inputSol = decodedBuy.solNotional;
    if (decodedBuy.family === "TOKEN_EXACT") {
      if (decodedBuy.tokenAmount != null)
        requestedTokens = decodedBuy.tokenAmount.toString();
      if (decodedBuy.maxSolCost != null)
        maxSolCost = decodedBuy.maxSolCost.toString();
      // Without bonding curve state at decode time we can't compute expected cost;
      // slippage bps filled later when curve is known.
    } else if (decodedBuy.family === "SOL_EXACT") {
      if (decodedBuy.minTokenOut != null)
        minTokensOut = decodedBuy.minTokenOut.toString();
      if (decodedBuy.solAmount != null)
        inputSol = Number(decodedBuy.solAmount) / 1e9;
    }
    break;
  }

  // Holder-reward heuristic: create_v2 args may carry extra flags after creator pubkey;
  // also detect "holder" in URI path (async metadata stays off hot path).
  const holderReward =
    /holder[-_]?reward/i.test(decoded.uri) ||
    /reward/i.test(decoded.name || "");

  decoded.intent = {
    creatorBuyInCreateTx: buyInstructionIndex != null,
    creatorBuySol,
    buyFamily,
    requestedTokens,
    maxSolCost,
    minTokensOut,
    inputSol,
    encodedSlippageBps,
    createInstructionIndex: createIxIndex,
    buyInstructionIndex,
    cuLimit,
    cuPriceMicroLamports,
    numInstructions: ixs.length,
    numSigners,
    hasAddressLookupTables,
    holderReward,
    deployer: decoded.deployer,
    declaredCreator: decoded.creator,
  };
  return decoded;
}

/** Parse preprocessedSubscribe binary frame → slot, sig, tx bytes */
export function parsePreprocessedFrame(buf: Buffer): {
  version: number;
  slot: number;
  signature: string;
  txBytes: Buffer;
} | null {
  if (buf.length < 74) return null;
  const version = buf.readUInt8(0);
  if (version !== 1) return null;
  const slot = Number(buf.readBigUInt64LE(1));
  const signature = bs58.encode(buf.subarray(9, 73));
  const txBytes = buf.subarray(73);
  return { version, slot, signature, txBytes };
}

export { SNIPE_TRACE_PATH, EXIT_TRACE_PATH };
