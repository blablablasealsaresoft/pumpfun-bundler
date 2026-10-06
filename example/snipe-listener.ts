/**
 * Unified Pump.fun create sniper
 *
 * Listener auto priority (Developer-first, no Business required):
 *   preprocessedSubscribe (beta WSS, ~8ms before processed)
 *     → transactionSubscribe @ processed
 *     → geyser @ processed (if GEYSER_ENDPOINT)
 *     → logsSubscribe
 *
 * Submit: SEND_MODE=rpc | sender_swqos | sender_max (Helius Sender)
 * Traces: wallets/snipe-traces.jsonl + exit-traces.jsonl (MFE/MAE)
 *
 *   npm run sniper:pump
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import bs58 from "bs58";
import { PumpFunSDK, BondingCurveAccount } from "../src";
import {
  classifyBuyError,
  classifyConstraintSeedsAccount,
  creatorBuyBucket,
  decodeCreateFromWireTx,
  formatSessionStats,
  logDecisionTrace,
  logExitTrace,
  logSnipeTrace,
  nowNs,
  parsePreprocessedFrame,
  resolveSendMode,
  senderTipLamports,
  RESEARCH,
  DecisionTrace,
  LaunchIntent,
  SnipeTrace,
  TraceResult,
  TraceSource,
} from "./snipe-infra";
import {
  loadCreatorCache,
  noteCreatorLaunch,
  noteCreatorOutcome,
  saveCreatorCache,
  scoreCreator,
  startCreatorCacheFlusher,
  CreatorSignal,
} from "./creator-cache";
import {
  loadDeployerCache,
  noteDeployerLaunch,
  noteDeployerOutcome,
  saveDeployerCache,
  scoreDeployer,
  startDeployerCacheFlusher,
  DeployerSignal,
} from "./deployer-cache";
import {
  blendAdmission,
  estimateEdge,
  resolveBuySol,
  noteExitPnl,
  expectancyKillSwitch,
  resetPromotionWindows,
  MIN_PROMOTION_CONV_N,
  UNIT_SOL,
  SelectionDecision,
} from "./selection-model";

dotenv.config({ path: path.join(__dirname, "../../.env") });
dotenv.config();

const PUMP_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const WSOL = "So11111111111111111111111111111111111111112";
/** pump.fun stores Pubkey::default() as quote_mint for SOL-paired creates */
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const CREATE_EVENT_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

/** Map on-chain quote_mint → tradable mint (default/system → WSOL). */
function normalizeQuoteMint(quoteMint: string | null | undefined): string {
  if (!quoteMint || quoteMint === DEFAULT_PUBKEY) return WSOL;
  return quoteMint;
}

function isSolQuote(quoteMint: string | null | undefined): boolean {
  return normalizeQuoteMint(quoteMint) === WSOL;
}

/** Live fixed size while conviction cohorts are shadowed */
const BUY_SOL = Number(process.env.SNIPE_BUY_SOL || "0.025");
const CONVICTION_SIZING = (process.env.SNIPE_CONVICTION || "true") === "true";
/** Live top-0.5% gate — OFF until shadow cohorts separate monotonically */
const LIVE_CONVICTION_GATE =
  (process.env.SNIPE_LIVE_CONVICTION_GATE || "false") === "true";
const BASE_UNITS = Number(process.env.SNIPE_BASE_UNITS || "1");
const MIN_RESERVE_SOL = Number(process.env.SNIPE_MIN_RESERVE_SOL || "0.04");
/** Catastrophic backup only — research does not support fixed % SL as primary */
const TAKE_PROFIT_PCT = Number(process.env.SNIPE_TAKE_PROFIT || "0");
const STOP_LOSS_PCT = Number(process.env.SNIPE_STOP_LOSS || "45");
const MAX_HOLD_MS = Number(process.env.SNIPE_MAX_HOLD_MS || "8000");
const EXIT_MODE = (process.env.SNIPE_EXIT_MODE || "flow_shadow").toLowerCase();
const TRANCHE_SHADOW = (process.env.SNIPE_TRANCHE_SHADOW || "true") === "true";
const POLL_MS = Number(
  process.env.SNIPE_POLL_MS ||
    ((process.env.SNIPE_DEAD_SHADOW || "true") === "true" ? "250" : "800")
);
const MIN_CREATOR_SOL = Number(process.env.SNIPE_MIN_CREATOR_SOL || "0.5");
const SKIP_MAYHEM = (process.env.SNIPE_SKIP_MAYHEM || "true") === "true";
const USE_LIST = (process.env.USE_SNIPE_LIST || "false") === "true";
const EXTREME_FAST = (process.env.SNIPE_EXTREME_FAST || "true") === "true";
const DYNAMIC_FEE = (process.env.SNIPE_DYNAMIC_FEE || "true") === "true";
const FEE_MULT = Number(process.env.SNIPE_FEE_MULT || "1.1");
const CU_PRICE_FLOOR = Number(process.env.SNIPE_CU_PRICE || "1000000");
const CU_PRICE_CAP = Number(process.env.SNIPE_CU_PRICE_CAP || "5000000");
const CU_LIMIT = Number(process.env.SNIPE_CU_LIMIT || "350000");
const MAX_CONCURRENT = Number(process.env.SNIPE_MAX_CONCURRENT || "2");
/** Same-slot posture: abandon if create is already stale */
const MAX_TOKEN_AGE_MS = Number(process.env.SNIPE_MAX_TOKEN_AGE_MS || "800");
const MAX_SLOT_LAG = Number(process.env.SNIPE_MAX_SLOT_LAG || "1");
const CLEANUP_ATA = (process.env.SNIPE_CLEANUP_ATA || "true") === "true";
const LISTENER =
  (process.env.SNIPE_LISTENER || "auto").toLowerCase() || "auto";
/** Soft live floor for data collection. Conviction top-% is shadowed, not gated. */
const MIN_CREATOR_SCORE = Number(process.env.SNIPE_MIN_CREATOR_SCORE || "45");
/** Soft deployer gate (0 = log-only). Farm wallets still hard-rejected below. */
const MIN_DEPLOYER_SCORE = Number(process.env.SNIPE_MIN_DEPLOYER_SCORE || "0");
/** Last N concurrent slots reserved for high-priority only (default 1 of MAX). */
const RESERVE_SLOTS = Number(process.env.SNIPE_RESERVE_SLOTS || "1");
const HIGH_PRIORITY_SCORE = Number(process.env.SNIPE_HIGH_PRIORITY_SCORE || "65");
/** Reject deployer with >= this many launches in last hour (serial farm). */
const MAX_DEPLOYER_LAUNCHES_1H = Number(process.env.SNIPE_MAX_DEPLOYER_1H || "10");
/** Edge gate in SOL; 0 = log-only EV shadow. */
const MIN_EDGE_SOL = Number(process.env.SNIPE_MIN_EDGE_SOL || "0");
const DECISION_SAMPLE = (process.env.SNIPE_DECISION_SAMPLE || "true") === "true";
/** Shadow early dead-trade classifier (log only unless SNIPE_DEAD_EXIT=true). */
const DEAD_SHADOW = (process.env.SNIPE_DEAD_SHADOW || "true") === "true";
const DEAD_EXIT = (process.env.SNIPE_DEAD_EXIT || "false") === "true";
/** Reject buys once curve MC exceeds this (SOL). Launch ≈28 SOL MC (~$4.5k @ $160). */
const MAX_ENTRY_MC_SOL = Number(process.env.SNIPE_MAX_ENTRY_MC_SOL || "45");
const SOL_USD = Number(process.env.SNIPE_SOL_USD || "160");
/** Blend weights — research: deployer >> creator/metadata */
const W_CREATOR = Number(process.env.SNIPE_W_CREATOR || "0.15");
const W_DEPLOYER = Number(process.env.SNIPE_W_DEPLOYER || "0.85");

/** Session telemetry — printed on each exit + periodic summary */
const stats = {
  snipes: 0,
  buyOk: 0,
  buyFail: 0,
  abortStale: 0,
  sellOk: 0,
  tp: 0,
  sl: 0,
  maxHold: 0,
  graduating: 0,
  skipped: 0,
  feesApproxSol: 0,
};

const SEND_MODE = resolveSendMode();
/** When true: listen + score + shadow labels only — never submit buys */
let SHADOW_OBSERVE_ONLY = false;
const claimedMints = new Set<string>();
const claimedCreateSigs = new Set<string>();
const mintSlotInfo = new Map<
  string,
  {
    createSlot?: number;
    buySlot?: number;
    slotDelta?: number;
    source?: TraceSource;
    createSig?: string;
  }
>();

/** First-decision-wins per mint — hard rejects never re-enter via another listener */
type CandidateState = "NEW" | "REJECTED" | "BUYING" | "HOLDING" | "DONE";
const candidateState = new Map<string, CandidateState>();
const softSkipLog = new Map<string, number>();
const firstSeenMsByMint = new Map<string, number>();

function getCandidateState(mint: string): CandidateState {
  return candidateState.get(mint) || "NEW";
}

function setCandidateState(mint: string, next: CandidateState): void {
  candidateState.set(mint, next);
  if (candidateState.size > 8000) {
    // drop oldest-ish by clearing; rare — research instrument bound
    candidateState.clear();
    firstSeenMsByMint.clear();
  }
}

/** Hard claim: NEW → REJECTED or BUYING. Returns false if already decided. */
function claimDecision(
  mint: string,
  next: "REJECTED" | "BUYING" = "REJECTED"
): boolean {
  if (getCandidateState(mint) !== "NEW") return false;
  setCandidateState(mint, next);
  return true;
}

function noteFirstSeen(mint: string): number {
  const existing = firstSeenMsByMint.get(mint);
  if (existing != null) return existing;
  const t = performance.now();
  firstSeenMsByMint.set(mint, t);
  return t;
}

function retryStillAllowed(
  c: { firstSeenMs: number; createSlot?: number },
  currentSlot: number
): { ok: boolean; ageMs: number; slotLag: number } {
  const ageMs = performance.now() - c.firstSeenMs;
  const slotLag =
    c.createSlot != null ? currentSlot - c.createSlot : 0;
  const ageOk = MAX_TOKEN_AGE_MS <= 0 || ageMs <= MAX_TOKEN_AGE_MS;
  const slotOk = MAX_SLOT_LAG < 0 || slotLag <= MAX_SLOT_LAG;
  return { ok: ageOk && slotOk, ageMs, slotLag };
}

/** Reservation: last RESERVE_SLOTS require HIGH_PRIORITY_SCORE */
function mayEnter(openN: number, admissionScore: number): string | null {
  if (openN >= MAX_CONCURRENT) return "max concurrent";
  const normalSlots = Math.max(0, MAX_CONCURRENT - Math.max(0, RESERVE_SLOTS));
  if (openN < normalSlots) return null;
  if (admissionScore >= HIGH_PRIORITY_SCORE) return null;
  return `reserve slot (score ${admissionScore} < ${HIGH_PRIORITY_SCORE})`;
}

function fmtConv(p: number | null | undefined): string {
  return p == null || Number.isNaN(p) ? "n/a" : `p${p.toFixed(2)}`;
}

function fmtConvWithN(
  p: number | null | undefined,
  n: number | null | undefined,
  nLabel = "convWindowN"
): string {
  const base = fmtConv(p);
  return `${base} ${nLabel}=${n ?? 0}`;
}

function curveUnitPrice(curve: BondingCurveAccount): number {
  try {
    const probe = 1_000_000n;
    const out = Number(curve.getSellPrice(probe, 100n));
    return out > 0 ? out / Number(probe) : 0;
  } catch {
    return 0;
  }
}

/**
 * Background: sample mints for counterfactual returns (curve reads only — never submits).
 * Uses executable SOL accounting for a hypothetical BUY_SOL round-trip on the bonding curve.
 */
function skipCohortOf(reason: string | undefined): string {
  const r = reason || "";
  if (/stale create/i.test(r)) return "stale_create";
  if (/^kill /i.test(r) || /avgExecPnl/i.test(r) || /discrimination/i.test(r))
    return "kill_gated";
  if (/mayhem/i.test(r)) return "mayhem";
  if (/creator SOL/i.test(r)) return "creator_sol";
  if (/admission/i.test(r) || /selection reject/i.test(r)) return "admission_floor";
  if (/slot lag/i.test(r)) return "slot_lag";
  if (/reserve|max concurrent/i.test(r)) return "capacity";
  if (/farm/i.test(r)) return "farm";
  return "other_skip";
}

const shadowInflight = new Set<string>();
const MAX_SHADOW_INFLIGHT = Number(process.env.SNIPE_MAX_SHADOW_INFLIGHT || "40");

function trackDecisionOutcome(
  sdk: PumpFunSDK,
  mintStr: string,
  creator: string,
  decision: DecisionTrace,
  deployer?: string
) {
  if (!DECISION_SAMPLE) return;
  if (shadowInflight.has(mintStr)) return;
  if (shadowInflight.size >= MAX_SHADOW_INFLIGHT) return;
  shadowInflight.add(mintStr);

  const mint = new PublicKey(mintStr);
  const started = Date.now();
  const costLamports = BigInt(Math.floor(BUY_SOL * LAMPORTS_PER_SOL));
  let tokenAmount = 0n;
  let entryCost = Number(costLamports);
  // Executable peak/trough on hypothetic position (same convention as live hold)
  let execPeak: number | null = null;
  let execTrough: number | null = null;
  const marks: Record<number, number | undefined> = {};
  // Legacy unit-price path retained only as forensic fields
  let entryPx = decision.hypotheticalEntryPrice || 0;
  let maxPx = entryPx;
  let minPx = entryPx || Number.POSITIVE_INFINITY;

  const quoteExecPnl = (curve: BondingCurveAccount): number | null => {
    try {
      if (tokenAmount <= 0n) {
        const tokens = curve.getBuyPrice(costLamports);
        if (tokens <= 0n) return null;
        tokenAmount = tokens;
      }
      const out = Number(curve.getSellPrice(tokenAmount, 100n));
      if (!(out > 0) || !(entryCost > 0)) return null;
      return ((out - entryCost) / entryCost) * 100;
    } catch {
      return null;
    }
  };

  const tick = async (atMs: number) => {
    const delay = Math.max(0, atMs - (Date.now() - started));
    await new Promise((r) => setTimeout(r, delay));
    try {
      const curve = await sdk.getBondingCurveAccount(mint, "confirmed");
      if (!curve) return;
      if (curve.complete) decision.graduated = true;
      const execPnl = quoteExecPnl(curve);
      if (execPnl != null) {
        marks[atMs] = execPnl;
        if (execPeak == null) {
          execPeak = execPnl;
          execTrough = execPnl;
        } else {
          if (execPnl > execPeak) execPeak = execPnl;
          if (execPnl < (execTrough as number)) execTrough = execPnl;
        }
      }
      const px = curveUnitPrice(curve);
      if (!entryPx && px > 0) {
        entryPx = px;
        maxPx = px;
        minPx = px;
        decision.hypotheticalEntryPrice = px;
      }
      if (px > 0 && entryPx > 0) {
        if (px > maxPx) maxPx = px;
        if (px < minPx) minPx = px;
      }
    } catch {
      /* */
    }
  };

  (async () => {
    try {
      await Promise.all([5_000, 10_000, 20_000, 30_000, 60_000].map((t) => tick(t)));
      decision.ret5s = marks[5_000];
      decision.ret10s = marks[10_000];
      decision.ret20s = marks[20_000];
      decision.ret30s = marks[30_000];
      decision.ret60s = marks[60_000];
      // Canonical shadow labels = executable curve path
      decision.mfe30s = execPeak ?? undefined;
      decision.mae30s = execTrough ?? undefined;
      decision.mfe60s = execPeak ?? undefined;
      decision.mae60s = execTrough ?? undefined;
      const skipCohort =
        decision.decision === "skip"
          ? skipCohortOf(decision.skipReason)
          : undefined;
      logDecisionTrace({
        ...decision,
        ts: Date.now(),
        sampleKind:
          decision.decision === "buy" ? "live_selected" : "shadow",
        skipCohort,
        shadowSample: decision.decision === "skip",
        executableShadow: true,
        skipReason:
          decision.decision === "skip"
            ? `${decision.skipReason}|outcome`
            : "buy|outcome",
      } as DecisionTrace);
      noteCreatorOutcome(creator, {
        mint: mintStr,
        ts: Date.now(),
        bought: decision.decision === "buy",
        mfePct: execPeak ?? decision.mfe60s,
        maePct: execTrough ?? decision.mae60s,
        pnlPct: decision.ret60s ?? decision.ret30s,
        graduated: decision.graduated,
      });
      if (deployer) {
        noteDeployerOutcome(deployer, {
          mint: mintStr,
          ts: Date.now(),
          bought: decision.decision === "buy",
          mfePct: execPeak ?? decision.mfe60s,
          maePct: execTrough ?? decision.mae60s,
          pnlPct: decision.ret60s ?? decision.ret30s,
          graduated: decision.graduated,
          sameTxBuy: decision.sameTxCreatorBuy,
          initialBuySol: decision.creatorBuySol,
          name: decision.name,
          symbol: decision.symbol,
        });
        saveDeployerCache();
      }
      saveCreatorCache();
    } finally {
      shadowInflight.delete(mintStr);
    }
  })().catch((e) => {
    shadowInflight.delete(mintStr);
    console.error("[decision] sample err", e);
  });
}

function emitSkipDecision(
  ctx: { sdk: PumpFunSDK },
  meta: CreateMeta,
  signature: string,
  reason: string,
  detect?: { source?: TraceSource; createSlot?: number },
  extra?: {
    creatorSol?: number;
    score?: number;
    unknown?: boolean;
    noClaim?: boolean;
    creatorSig?: CreatorSignal;
    deployerSig?: DeployerSignal;
    admissionScore?: number;
    edge?: { pRunner: number; pAdverse: number; expectedPnl30: number; edgeSol: number };
    sel?: SelectionDecision;
  }
) {
  if (!extra?.noClaim && !claimDecision(meta.mint)) return;
  if (extra?.noClaim) {
    const last = softSkipLog.get(meta.mint) || 0;
    if (Date.now() - last < 2000) return;
    softSkipLog.set(meta.mint, Date.now());
  }
  const deployer = meta.user || meta.intent?.deployer || meta.creator;
  const scored =
    extra?.creatorSig ||
    (extra?.score != null
      ? ({
          score: extra.score,
          quality: extra.score,
          confidence: 0,
          observations: 0,
          unknown: !!extra.unknown,
          creator: meta.creator,
          launches: 0,
          winRate: null,
          dumpRate: null,
          avgMfe: null,
          reasons: [],
        } as CreatorSignal)
      : scoreCreator(meta.creator, { creatorSol: extra?.creatorSol }));
  const dep = extra?.deployerSig || scoreDeployer(deployer);
  const admission = extra?.admissionScore ?? blendAdmission(scored, dep);
  const edge =
    extra?.edge ||
    estimateEdge({ creator: scored, deployer: dep, buySol: BUY_SOL });
  if (!extra?.noClaim) {
    noteCreatorLaunch(meta.creator, meta.mint, false, extra?.creatorSol);
    noteDeployerLaunch(deployer, meta.mint, false, {
      sameTxBuy: meta.intent?.creatorBuyInCreateTx,
      initialBuySol: meta.intent?.creatorBuySol,
      name: meta.name,
      symbol: meta.symbol,
      uri: meta.uri,
    });
  }
  const row: DecisionTrace = {
    mint: meta.mint,
    creator: meta.creator,
    deployer,
    createSig: signature,
    createSlot: detect?.createSlot,
    source: detect?.source,
    decision: "skip",
    skipReason: reason,
    creatorScore: admission,
    creatorScoreUnknown: scored.unknown,
    rawScore: scored.quality,
    effectiveScore: scored.score,
    confidence: scored.confidence,
    creatorN: scored.observations,
    deployerScore: dep.score,
    deployerN: dep.observations,
    deployerLaunches1h: dep.launches1h,
    creatorSol: extra?.creatorSol,
    mayhem: meta.isMayhem,
    nameBlocked: /blacklist/i.test(reason),
    symbol: meta.symbol,
    name: meta.name,
    sameTxCreatorBuy: meta.intent?.creatorBuyInCreateTx,
    creatorBuySol: meta.intent?.creatorBuySol,
    creatorBuyBucket: creatorBuyBucket(meta.intent?.creatorBuySol),
    cuLimit: meta.intent?.cuLimit,
    cuPriceMicroLamports: meta.intent?.cuPriceMicroLamports,
    numInstructions: meta.intent?.numInstructions,
    numSigners: meta.intent?.numSigners,
    hasAddressLookupTables: meta.intent?.hasAddressLookupTables,
    holderReward: meta.intent?.holderReward,
    tokenProgram: meta.tokenProgram,
    pRunner: edge.pRunner,
    pAdverse: edge.pAdverse,
    expectedPnl30: edge.expectedPnl30,
    edgeSol: edge.edgeSol,
    convictionPct: extra?.sel?.globalConvPct,
    globalConvPct: extra?.sel?.globalConvPct,
    eligibleConvPct: extra?.sel?.eligibleConvPct,
    globalConvN: extra?.sel?.globalConvN,
    eligibleConvN: extra?.sel?.eligibleConvN,
    shadowTop5: extra?.sel?.shadowCohorts.top5,
    shadowTop2: extra?.sel?.shadowCohorts.top2,
    shadowTop1: extra?.sel?.shadowCohorts.top1,
    shadowTop05: extra?.sel?.shadowCohorts.top05,
    shadowTop01: extra?.sel?.shadowCohorts.top01,
    shadowBuySol: extra?.sel?.shadowBuySol,
    buyFamily: meta.intent?.buyFamily,
    maxSolCost: meta.intent?.maxSolCost,
    minTokensOut: meta.intent?.minTokensOut,
    encodedSlippageBps: meta.intent?.encodedSlippageBps,
    deployerLaunchesPerDay: extra?.sel?.core.deployerLaunchesPerDay,
    secsSincePriorLaunch: extra?.sel?.core.secondsSincePriorLaunch,
    historicalDevBuyMeanSol: extra?.sel?.core.historicalDevBuyMeanSol,
    deployerPreviouslyProfitable: extra?.sel?.core.deployerPreviouslyProfitable,
    sampleKind: "shadow",
    shadowSample: true,
    skipCohort: skipCohortOf(reason),
    ts: Date.now(),
  };
  logDecisionTrace(row);
  trackDecisionOutcome(ctx.sdk, meta.mint, meta.creator, row, deployer);
}


function claimCreate(mint: string, sig: string): boolean {
  if (claimedMints.has(mint) || (sig && claimedCreateSigs.has(sig))) return false;
  claimedMints.add(mint);
  if (sig) claimedCreateSigs.add(sig);
  if (claimedMints.size > 5000) {
    claimedMints.clear();
    claimedCreateSigs.clear();
  }
  return true;
}

type CreateMeta = {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
  /** Deployer = create.user / fee-payer */
  user: string;
  /** Declared create_v2 creator arg */
  creator: string;
  intent?: LaunchIntent;
  timestamp: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenProgram: string;
  isMayhem: boolean;
  quoteMint: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function loadSnipeList(): Set<string> {
  return new Set(
    loadLines(path.join(__dirname, "../../pumpfun-sniper-red/snipe-list.txt"))
  );
}

function loadSkipMints(): Set<string> {
  const skip = new Set(
    loadLines(path.join(__dirname, "../../wallets/our-mints.txt"))
  );
  skip.add("7CtA5t6yQMV2fXVG8uJLYPtDuh5UKtAGdagSJxfnpNXL");
  return skip;
}

function loadNameBlacklist(): string[] {
  const defaults = [
    "test",
    "scam",
    "rug",
    "airdrop",
    "official elon",
    "trump coin",
    "whitehouse",
    "irs ",
    "fbi ",
  ];
  return [
    ...defaults,
    ...loadLines(path.join(__dirname, "../../wallets/name-blacklist.txt")).map(
      (s) => s.toLowerCase()
    ),
  ];
}

function isPumpCreateLog(logs: string[]): boolean {
  return logs.some(
    (l) =>
      l === "Program log: Instruction: Create" ||
      l === "Program log: Instruction: CreateV2"
  );
}

function readBorshString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) throw new Error("string OOB");
  return [buf.slice(start, end).toString("utf8"), end];
}

function readPubkey(buf: Buffer, offset: number): [string, number] {
  return [new PublicKey(buf.slice(offset, offset + 32)).toBase58(), offset + 32];
}

function readU64(buf: Buffer, offset: number): [bigint, number] {
  return [buf.readBigUInt64LE(offset), offset + 8];
}

function readI64(buf: Buffer, offset: number): [number, number] {
  return [Number(buf.readBigInt64LE(offset)), offset + 8];
}

function readBool(buf: Buffer, offset: number): [boolean, number] {
  return [buf[offset] !== 0, offset + 1];
}

/** Full CreateEvent decode (matches pump IDL). */
function parseCreateEvent(logs: string[]): CreateMeta | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const raw = Buffer.from(line.slice("Program data: ".length), "base64");
      if (raw.length < 8 || !raw.slice(0, 8).equals(CREATE_EVENT_DISC)) continue;
      let o = 8;
      let name: string, symbol: string, uri: string;
      [name, o] = readBorshString(raw, o);
      [symbol, o] = readBorshString(raw, o);
      [uri, o] = readBorshString(raw, o);
      let mint: string,
        bondingCurve: string,
        user: string,
        creator: string,
        tokenProgram: string,
        quoteMint: string;
      let timestamp: number;
      let virtualTokenReserves: bigint,
        virtualSolReserves: bigint,
        realTokenReserves: bigint;
      let isMayhem: boolean;
      [mint, o] = readPubkey(raw, o);
      [bondingCurve, o] = readPubkey(raw, o);
      [user, o] = readPubkey(raw, o);
      [creator, o] = readPubkey(raw, o);
      [timestamp, o] = readI64(raw, o);
      [virtualTokenReserves, o] = readU64(raw, o);
      [virtualSolReserves, o] = readU64(raw, o);
      [realTokenReserves, o] = readU64(raw, o);
      o += 8; // token_total_supply
      [tokenProgram, o] = readPubkey(raw, o);
      [isMayhem, o] = readBool(raw, o);
      o += 1; // is_cashback_enabled
      [quoteMint, o] = readPubkey(raw, o);
      return {
        mint,
        name,
        symbol,
        uri,
        bondingCurve,
        user,
        creator,
        timestamp,
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        tokenProgram,
        isMayhem,
        quoteMint: normalizeQuoteMint(quoteMint),
      };
    } catch {
      /* ignore malformed */
    }
  }
  return null;
}


/** Bonding-curve FDV proxy in SOL from virtual reserves (pump 1e9 supply / 6dp). */
function estimateMcSol(vSol: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return (Number(vSol) * 1e6) / Number(vToken);
}
function estimateMcUsd(vSol: bigint, vToken: bigint): number {
  return estimateMcSol(vSol, vToken) * SOL_USD;
}

function nameBlocked(name: string, symbol: string, bl: string[]): boolean {
  const hay = `${name} ${symbol}`.toLowerCase();
  return bl.some((b) => b && hay.includes(b));
}

/** Extreme-fast filters from CreateEvent alone (no RPC). */
function eventFilterReject(
  meta: CreateMeta,
  blacklist: string[],
  buyer: PublicKey
): string | null {
  if (!isSolQuote(meta.quoteMint)) return `non-SOL quote (${meta.quoteMint})`;
  if (SKIP_MAYHEM && meta.isMayhem) return "mayhem mode";
  if (nameBlocked(meta.name, meta.symbol, blacklist)) {
    return `name blacklist (${meta.name}/${meta.symbol})`;
  }
  if (meta.creator === buyer.toBase58() || meta.user === buyer.toBase58()) {
    return "we created";
  }
  if (MAX_TOKEN_AGE_MS > 0 && meta.timestamp > 0) {
    const ageMs = Date.now() - meta.timestamp * 1000;
    if (ageMs > MAX_TOKEN_AGE_MS) return `too old ${ageMs}ms`;
  }
  return null;
}

async function waitForCurve(sdk: PumpFunSDK, mint: PublicKey, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const curve = await sdk.getBondingCurveAccount(mint, "confirmed");
      if (curve) return curve;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function tokenAta(mint: PublicKey, owner: PublicKey, mintOwner: PublicKey) {
  const tokenProgram = mintOwner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  return {
    ata: getAssociatedTokenAddressSync(mint, owner, false, tokenProgram),
    tokenProgram,
  };
}

let cachedCuPrice = CU_PRICE_FLOOR;
let cachedCuAt = 0;

/** Median recent prioritization fee × multiplier, floored/capped. */
async function resolveCuPrice(connection: Connection): Promise<number> {
  if (!DYNAMIC_FEE) return CU_PRICE_FLOOR;
  if (Date.now() - cachedCuAt < 5_000) return cachedCuPrice;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    const vals = fees
      .map((f) => f.prioritizationFee)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!vals.length) return cachedCuPrice;
    const mid = vals[Math.floor(vals.length / 2)];
    const priced = Math.floor(mid * FEE_MULT);
    cachedCuPrice = Math.min(
      CU_PRICE_CAP,
      Math.max(CU_PRICE_FLOOR, priced || CU_PRICE_FLOOR)
    );
    cachedCuAt = Date.now();
    return cachedCuPrice;
  } catch {
    return cachedCuPrice;
  }
}

async function buyMint(
  sdk: PumpFunSDK,
  connection: Connection,
  buyer: Keypair,
  mint: PublicKey,
  solAmount: number,
  meta?: CreateMeta,
  feeRecipient?: PublicKey,
  traceCtx?: {
    source: TraceSource;
    createSig: string;
    createSlot?: number;
    receivedNs: string;
    decodedNs?: string;
    filteredNs?: string;
    firstSeenMs?: number;
  }
) {
  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
  const cuPrice = await resolveCuPrice(connection);
  let useEvent = !!(EXTREME_FAST && meta);
  const mintStr = mint.toBase58();
  const firstSeenMs =
    traceCtx?.firstSeenMs ?? noteFirstSeen(mintStr);
  console.log(
    `[buy] ${mintStr} sol=${solAmount} cuPrice=${cuPrice} mode=${
      useEvent ? "event" : "rpc"
    } send=${SEND_MODE}`
  );

  const maxAttempts = useEvent ? 3 : 2;
  let result: Awaited<ReturnType<PumpFunSDK["buy"]>> = {
    success: false,
    error: "not attempted",
  };
  const tipLamports = senderTipLamports(SEND_MODE);
  const priorityFeeLamports = Math.floor((cuPrice * CU_LIMIT) / 1_000_000);

  for (let i = 0; i < maxAttempts; i++) {
    // Re-check freshness on every attempt (including 6002 rebuild)
    if (MAX_TOKEN_AGE_MS > 0 || MAX_SLOT_LAG >= 0) {
      let currentSlot = 0;
      try {
        currentSlot = await connection.getSlot("processed");
      } catch {
        /* non-fatal — age check still applies */
      }
      const fresh = retryStillAllowed(
        { firstSeenMs, createSlot: traceCtx?.createSlot },
        currentSlot
      );
      if (!fresh.ok) {
        console.log(
          `[buy] abort_stale_retry mint=${mintStr.slice(0, 8)}… age=${fresh.ageMs.toFixed(
            0
          )}ms slotLag=${fresh.slotLag} attempt=${i + 1}`
        );
        stats.abortStale++;
        if (traceCtx) {
          logSnipeTrace({
            createSig: traceCtx.createSig,
            mint: mintStr,
            source: traceCtx.source,
            createSlot: traceCtx.createSlot,
            receivedNs: traceCtx.receivedNs,
            detectedNs: traceCtx.receivedNs,
            decodedNs: traceCtx.decodedNs,
            filteredNs: traceCtx.filteredNs,
            builtNs: nowNs().toString(),
            sendMode: SEND_MODE,
            attempt: i + 1,
            attemptClass: useEvent && meta ? "event" : "rpc_rebuild",
            result: "abort_stale",
            priorityFeeLamports,
            tipLamports,
            err: `abort_stale_retry age=${fresh.ageMs.toFixed(0)}ms lag=${fresh.slotLag}`,
          });
        }
        return {
          success: false,
          error: `abort_stale_retry age=${fresh.ageMs.toFixed(0)}ms lag=${fresh.slotLag}`,
        };
      }
    }

    const t0 = Date.now();
    const attemptClass = useEvent && meta ? "event" : "rpc_rebuild";
    const builtNsLocal = nowNs().toString();
    if (useEvent && meta) {
      result = await sdk.buyFromCreateEvent(
        buyer,
        mint,
        lamports,
        {
          creator: new PublicKey(meta.creator),
          tokenProgram: new PublicKey(meta.tokenProgram),
          virtualTokenReserves: meta.virtualTokenReserves,
          virtualSolReserves: meta.virtualSolReserves,
          realTokenReserves:
            meta.realTokenReserves > 0n
              ? meta.realTokenReserves
              : meta.virtualTokenReserves,
        },
        5000n,
        { unitLimit: CU_LIMIT, unitPrice: cuPrice },
        "processed",
        "confirmed",
        feeRecipient
      );
    } else {
      // Fresh rebuild/resign each attempt — never resubmit identical signed bytes after 2006
      result = await sdk.buy(
        buyer,
        mint,
        lamports,
        2500n,
        { unitLimit: CU_LIMIT, unitPrice: cuPrice },
        "confirmed",
        "confirmed",
        { skipSimulation: true }
      );
    }
    const ms = Date.now() - t0;

    const emitTrace = async (res: TraceResult) => {
      if (!traceCtx) return;
      let buySlot: number | undefined;
      // Prefer confirmation slot from getSignatureStatuses after confirm path
      if (result.signature) {
        try {
          const st = await connection.getSignatureStatuses([result.signature], {
            searchTransactionHistory: true,
          });
          buySlot = st?.value?.[0]?.slot ?? undefined;
        } catch {
          /* */
        }
      }
      const receivedNs = traceCtx.receivedNs;
      const builtNs = result.builtNs || builtNsLocal;
      const signedNs = result.signedNs;
      const submittedNs = result.submittedNs;
      const ackNs = result.ackNs;
      logSnipeTrace({
        createSig: traceCtx.createSig,
        mint: mint.toBase58(),
        source: traceCtx.source,
        createSlot: traceCtx.createSlot,
        buySlot,
        slotDelta:
          traceCtx.createSlot != null && buySlot != null
            ? buySlot - traceCtx.createSlot
            : undefined,
        receivedNs,
        detectedNs: receivedNs,
        decodedNs: traceCtx.decodedNs,
        filteredNs: traceCtx.filteredNs,
        builtNs,
        signedNs,
        submittedNs,
        ackNs,
        sendAckNs: ackNs,
        buySig: result.signature,
        sendMode: SEND_MODE,
        attempt: i + 1,
        attemptClass,
        result: res,
        priorityFeeLamports,
        tipLamports: result.tipLamports ?? tipLamports,
        err: result.success
          ? undefined
          : JSON.stringify(result.error ?? "").slice(0, 240),
      });
      // stash for exit join
      if (res === "ok" && buySlot != null) {
        mintSlotInfo.set(mint.toBase58(), {
          createSlot: traceCtx.createSlot,
          buySlot,
          slotDelta:
            traceCtx.createSlot != null ? buySlot - traceCtx.createSlot : undefined,
          source: traceCtx.source,
          createSig: traceCtx.createSig,
        });
      }
    };

    if (result.success) {
      stats.buyOk++;
      console.log(
        `[buy] OK ${ms}ms mode=${useEvent ? "event" : "rpc"} https://solscan.io/tx/${result.signature}`
      );
      await emitTrace("ok");
      return result;
    }

    const errStr = JSON.stringify(result.error ?? "");
    const seeds =
      /2006|ConstraintSeeds|AccountNotFound|IncorrectOwner/i.test(errStr);
    const slip = /6002|TooMuchSolRequired/i.test(errStr);
    const graduated = /6005|BondingCurveComplete/i.test(errStr);
    const fatal = graduated || /6000|NotAuthorized/i.test(errStr);

    const classified = classifyBuyError(result.error);
    console.error(
      `[buy] FAIL attempt ${i + 1}/${maxAttempts} ${ms}ms class=${classified}`,
      result.error
    );
    if (classified === "2006") {
      const acct = classifyConstraintSeedsAccount(result.error);
      console.log(
        `[buy] ConstraintSeeds 2006 account=${acct} — rebuild+retry (race vs builder)`
      );
    }
    // IllegalOwner flip — wrong token program on preprocessed decode
    if (/IllegalOwner/i.test(errStr) && useEvent && meta) {
      const cur = meta.tokenProgram;
      meta.tokenProgram =
        cur === TOKEN_2022_PROGRAM_ID.toBase58()
          ? TOKEN_PROGRAM_ID.toBase58()
          : TOKEN_2022_PROGRAM_ID.toBase58();
      console.log(
        "[buy] IllegalOwner flip — tokenProgram",
        meta.tokenProgram.slice(0, 8) + "…"
      );
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    await emitTrace(classified);

    if (fatal) {
      console.log(
        `[buy] abort — non-retryable (${graduated ? "graduated" : "auth"})`
      );
      break;
    }

    if (useEvent && (slip || seeds)) {
      console.log(
        `[buy] ${slip ? "stale quote" : "seeds race"} → RPC buy (fresh build)`
      );
      useEvent = false;
      await new Promise((r) => setTimeout(r, seeds ? 60 : 20));
      continue;
    }

    if (!seeds || i === maxAttempts - 1) break;
    await new Promise((r) => setTimeout(r, 50 + i * 50));
  }

  stats.buyFail++;
  return result;
}

async function sellAll(
  sdk: PumpFunSDK,
  connection: Connection,
  seller: Keypair,
  mint: PublicKey,
  reason: string
) {
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) return { success: false, error: "no mint" };
  const { ata, tokenProgram } = tokenAta(
    mint,
    seller.publicKey,
    mintInfo.owner
  );
  const cuPrice = await resolveCuPrice(connection);
  for (let i = 0; i < 12; i++) {
    try {
      const bal = await connection.getTokenAccountBalance(ata);
      const amount = BigInt(bal.value.amount);
      if (amount > 0n) {
        console.log(
          `[sell:${reason}] dumping ${bal.value.uiAmountString} ${mint.toBase58()}`
        );
        const result = await sdk.sell(
          seller,
          mint,
          amount,
          2500n,
          { unitLimit: CU_LIMIT, unitPrice: cuPrice },
          "confirmed"
        );
        if (result.success) {
          console.log(`[sell] OK https://solscan.io/tx/${result.signature}`);
          if (CLEANUP_ATA) {
            await closeAta(connection, seller, ata, tokenProgram, cuPrice);
          }
        } else {
          console.error(`[sell] FAIL`, result.error);
        }
        return result;
      }
    } catch {
      /* wait ata */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`[sell] no balance ${mint.toBase58()}`);
  return { success: false, error: "no balance" };
}

async function closeAta(
  connection: Connection,
  owner: Keypair,
  ata: PublicKey,
  tokenProgram: PublicKey,
  cuPrice: number
) {
  try {
    const ix = createCloseAccountInstruction(
      ata,
      owner.publicKey,
      owner.publicKey,
      [],
      tokenProgram
    );
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ix
    );
    const sig = await connection.sendTransaction(tx, [owner], {
      skipPreflight: true,
      maxRetries: 2,
    });
    console.log(`[cleanup] closed ATA https://solscan.io/tx/${sig}`);
  } catch (e) {
    console.log(`[cleanup] skip`, (e as Error).message?.slice(0, 80));
  }
}

async function monitorAndExit(
  sdk: PumpFunSDK,
  connection: Connection,
  seller: Keypair,
  mint: PublicKey,
  buySol: number,
  createSig?: string,
  source?: TraceSource,
  admissionScore: number = 50
) {
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) return;
  const { ata } = tokenAta(mint, seller.publicKey, mintInfo.owner);

  let raw = 0n;
  for (let i = 0; i < 15; i++) {
    try {
      raw = BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
      if (raw > 0n) break;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (raw <= 0n) {
    console.log(`[hold] no tokens after buy — skip monitor`);
    return;
  }

  const costLamports = buySol * LAMPORTS_PER_SOL;
  const tpMult = TAKE_PROFIT_PCT > 0 ? 1 + TAKE_PROFIT_PCT / 100 : Number.POSITIVE_INFINITY;
  const slMult = STOP_LOSS_PCT > 0 ? 1 - STOP_LOSS_PCT / 100 : 0;
  const started = Date.now();
  let lastPnlPct = 0;
  let lastOutSol = 0;
  let entryPrice = 0;
  let maxPrice = 0;
  let minPrice = Number.POSITIVE_INFINITY;
  let timeToMfeMs = 0;
  let timeToMaeMs = 0;
  // Canonical executable peak/trough since first fill quote — never window-reset
  let execPeakPnl: number | null = null;
  let execTroughPnl: number | null = null;
  const deadMarks: Record<
    number,
    { pnl: number; mfe: number; mae: number }
  > = {};
  let deadShadowLogged = false;
  let trancheShadowLogged = 0;
  const recipeHits: Record<string, number> = {
    "20/30/50": 0,
    "25/25/50": 0,
    "33/33/34": 0,
  };
  const recipeAcc: Record<
    string,
    { hits: number; totalSol: number; runnerSol: number; legs: number[] }
  > = {
    "20/30/50": { hits: 0, totalSol: 0, runnerSol: 0, legs: [] },
    "25/25/50": { hits: 0, totalSol: 0, runnerSol: 0, legs: [] },
    "33/33/34": { hits: 0, totalSol: 0, runnerSol: 0, legs: [] },
  };
  setCandidateState(mint.toBase58(), "HOLDING");
  console.log(
    `[hold] mode=${EXIT_MODE} TP ${TAKE_PROFIT_PCT || "off"} / SL -${STOP_LOSS_PCT || "off"} / max ${MAX_HOLD_MS}ms dead=${DEAD_EXIT ? "exit" : DEAD_SHADOW ? "shadow" : "off"} tranche=${TRANCHE_SHADOW ? "shadow" : "off"}`
  );

  const finish = async (reason: string) => {
    const holdMs = Date.now() - started;
    const sold = await sellAll(sdk, connection, seller, mint, reason);
    if (sold.success) {
      stats.sellOk++;
      if (reason.startsWith("TP_")) stats.tp++;
      else if (reason.startsWith("SL_")) stats.sl++;
      else if (reason === "MAX_HOLD") stats.maxHold++;
      else if (reason === "graduating") stats.graduating++;
    }
    // Legacy unit-price path — retained for forensics only; never train on these
    const legacyMfePct =
      entryPrice > 0 ? ((maxPrice - entryPrice) / entryPrice) * 100 : 0;
    const legacyMaePct =
      entryPrice > 0 ? ((minPrice - entryPrice) / entryPrice) * 100 : 0;
    const executableMfePct = execPeakPnl ?? 0;
    const executableMaePct = execTroughPnl ?? 0;
    const tailEvent = executableMfePct >= 100 || lastPnlPct >= 100;
    if (tailEvent) {
      console.log(
        `[tail] mint=${mint.toBase58().slice(0, 8)}… execMFE=${executableMfePct.toFixed(
          1
        )}% execPnL=${lastPnlPct.toFixed(1)}% — keep for fat-tail / tranche capture analysis`
      );
    }
    console.log(
      `[exit] mint=${mint.toBase58()} reason=${reason} holdMs=${holdMs} execPnl=${lastPnlPct.toFixed(
        1
      )}% execMFE=${executableMfePct.toFixed(1)}% execMAE=${executableMaePct.toFixed(
        1
      )}% buySol=${buySol} estOutSol=${lastOutSol.toFixed(5)} sold=${!!sold.success}`
    );
    noteExitPnl(lastPnlPct, {
      admissionScore,
      execMfePct: executableMfePct,
    });
    const slotInfo = mintSlotInfo.get(mint.toBase58());
    logExitTrace({
      mint: mint.toBase58(),
      createSig: createSig || slotInfo?.createSig,
      source: source || slotInfo?.source,
      createSlot: slotInfo?.createSlot,
      buySlot: slotInfo?.buySlot,
      slotDelta: slotInfo?.slotDelta,
      entrySol: buySol,
      exitSol: lastOutSol,
      entryPrice,
      maxPrice,
      minPrice: Number.isFinite(minPrice) ? minPrice : entryPrice,
      exitPrice: lastOutSol,
      exitReason: reason,
      timeToMfeMs,
      timeToMaeMs,
      holdMs,
      legacyMfePct,
      legacyMaePct,
      mfePct: legacyMfePct,
      maePct: legacyMaePct,
      executableMfePct,
      executableMaePct,
      pnlPct: lastPnlPct,
      sendMode: SEND_MODE,
      tailEvent,
      trancheRecipes: recipeAcc,
    });
    try {
      const creatorFromCurve = (
        await sdk.getBondingCurveAccount(mint, "confirmed")
      )?.creator?.toBase58?.();
      if (creatorFromCurve) {
        noteCreatorOutcome(creatorFromCurve, {
          mint: mint.toBase58(),
          ts: Date.now(),
          bought: true,
          mfePct: executableMfePct,
          maePct: executableMaePct,
          pnlPct: lastPnlPct,
          graduated: reason === "graduating",
        });
      }
    } catch {
      /* */
    }
    setCandidateState(mint.toBase58(), "DONE");
    printStats();
  };

  while (Date.now() - started < MAX_HOLD_MS) {
    try {
      const curve = await sdk.getBondingCurveAccount(mint, "confirmed");
      if (!curve || curve.complete) {
        await finish("graduating");
        return;
      }
      const bal = await connection.getTokenAccountBalance(ata);
      const amount = BigInt(bal.value.amount);
      if (amount <= 0n) return;

      const out = Number(curve.getSellPrice(amount, 100n));
      const ratio = out / costLamports;
      lastOutSol = out / LAMPORTS_PER_SOL;
      lastPnlPct = (ratio - 1) * 100;
      // Canonical cumulative executable peak/trough from first quote after fill
      if (execPeakPnl == null) {
        execPeakPnl = lastPnlPct;
        execTroughPnl = lastPnlPct;
        timeToMfeMs = 0;
        timeToMaeMs = 0;
      } else {
        if (lastPnlPct > execPeakPnl) {
          execPeakPnl = lastPnlPct;
          timeToMfeMs = Date.now() - started;
        }
        if (lastPnlPct < (execTroughPnl as number)) {
          execTroughPnl = lastPnlPct;
          timeToMaeMs = Date.now() - started;
        }
      }
      // Executable bonding-curve mark (NOT market-cap ratio)
      const executableSol = lastOutSol;
      const px = amount > 0n ? lastOutSol / Number(amount) : 0;
      if (!entryPrice && px > 0) {
        entryPrice = px;
        maxPrice = px;
        minPrice = px;
      } else if (px > 0) {
        if (px > maxPrice) maxPrice = px;
        if (px < minPrice) minPrice = px;
      }
      const elapsed = Date.now() - started;
      // Snapshot cumulative exec peak/trough at each mark — never restart MFE window
      for (const t of [250, 500, 1000, 2000, 3000, 5000]) {
        if (elapsed >= t && deadMarks[t] == null) {
          deadMarks[t] = {
            pnl: lastPnlPct,
            mfe: execPeakPnl ?? 0,
            mae: execTroughPnl ?? 0,
          };
        }
      }
      // Experimental tranche ladders — EACH simulated sale uses executable curve quote
      if (TRANCHE_SHADOW) {
        const recipes: {
          name: string;
          cuts: number[];
          fracs: number[];
        }[] = [
          { name: "20/30/50", cuts: [8, 18, 35], fracs: [0.2, 0.3, 0.5] },
          { name: "25/25/50", cuts: [10, 20, 40], fracs: [0.25, 0.25, 0.5] },
          { name: "33/33/34", cuts: [8, 18, 35], fracs: [0.33, 0.33, 0.34] },
        ];
        for (const rec of recipes) {
          const next = recipeHits[rec.name];
          if (next < rec.cuts.length && lastPnlPct >= rec.cuts[next]) {
            recipeHits[rec.name] = next + 1;
            const frac = rec.fracs[next];
            const sellAmt = BigInt(
              Math.max(1, Math.floor(Number(amount) * frac))
            );
            let trancheSol = 0;
            try {
              trancheSol =
                Number(curve.getSellPrice(sellAmt, 100n)) / LAMPORTS_PER_SOL;
            } catch {
              trancheSol = executableSol * frac;
            }
            const runnerLeft = Math.max(
              0,
              1 - rec.fracs.slice(0, next + 1).reduce((a, b) => a + b, 0)
            );
            let runnerSol = 0;
            try {
              if (runnerLeft > 0) {
                const leftAmt = BigInt(
                  Math.max(0, Math.floor(Number(amount) * runnerLeft))
                );
                if (leftAmt > 0n)
                  runnerSol =
                    Number(curve.getSellPrice(leftAmt, 100n)) /
                    LAMPORTS_PER_SOL;
              }
            } catch {
              /* */
            }
            const acc = recipeAcc[rec.name];
            acc.hits = next + 1;
            acc.legs.push(trancheSol);
            acc.totalSol = acc.legs.reduce((a, b) => a + b, 0);
            acc.runnerSol = runnerSol;
            console.log(
              `[tranche:shadow] ${rec.name} T${next + 1} mint=${mint
                .toBase58()
                .slice(0, 8)}… triggerPnl=${lastPnlPct.toFixed(
                1
              )}% soldFrac=${(frac * 100).toFixed(0)}% execSolIn=${trancheSol.toFixed(
                5
              )} runnerLeftSol=${runnerSol.toFixed(5)} totalExecSol=${acc.totalSol.toFixed(
                5
              )} age=${elapsed}ms`
            );
          }
        }
        if (
          trancheShadowLogged < 3 &&
          lastPnlPct >= [8, 18, 35][trancheShadowLogged]
        ) {
          trancheShadowLogged++;
        }
      }
      if (
        (DEAD_SHADOW || DEAD_EXIT) &&
        !deadShadowLogged &&
        deadMarks[2000] &&
        deadMarks[2000].pnl <= 0 &&
        deadMarks[2000].mfe < 5
      ) {
        deadShadowLogged = true;
        console.log(
          `[dead] ${DEAD_EXIT ? "EXIT" : "shadow"} mint=${mint
            .toBase58()
            .slice(0, 8)}… pnl2s=${deadMarks[2000].pnl.toFixed(
            1
          )}% mfe2s=${deadMarks[2000].mfe.toFixed(
            1
          )}% mae2s=${deadMarks[2000].mae.toFixed(
            1
          )}% marks=${JSON.stringify(deadMarks)}`
        );
        if (DEAD_EXIT) {
          await finish("DEAD_NODEMAND");
          return;
        }
      }
      if (elapsed % 4000 < POLL_MS) {
        console.log(
          `[hold] ${mint.toBase58().slice(0, 8)}… execPnl~${lastPnlPct.toFixed(1)}% out=${executableSol.toFixed(5)}`
        );
      }
      if (TAKE_PROFIT_PCT > 0 && ratio >= tpMult) {
        await finish(`TP_${TAKE_PROFIT_PCT}`);
        return;
      }
      if (STOP_LOSS_PCT > 0 && ratio <= slMult) {
        await finish(`SL_${STOP_LOSS_PCT}`);
        return;
      }
    } catch (e) {
      console.error(`[hold] err`, (e as Error).message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await finish("MAX_HOLD");
}

function printStats() {
  const closed = stats.tp + stats.sl + stats.maxHold + stats.graduating;
  const winRate = closed ? ((stats.tp / closed) * 100).toFixed(0) : "n/a";
  console.log(
    `[stats] buyOk=${stats.buyOk} buyFail=${stats.buyFail} abortStale=${stats.abortStale} sellOk=${stats.sellOk} TP=${stats.tp} SL=${stats.sl} maxHold=${stats.maxHold} win%=${winRate}`
  );
  console.log(
    formatSessionStats({
      snipes: stats.snipes,
      abortStale: stats.abortStale,
    })
  );
}

async function creatorSolOk(
  connection: Connection,
  creator: PublicKey
): Promise<string | null> {
  if (MIN_CREATOR_SOL <= 0) return null;
  try {
    const cBal = await connection.getBalance(creator, "confirmed");
    if (cBal / LAMPORTS_PER_SOL < MIN_CREATOR_SOL) {
      return `creator SOL ${(cBal / LAMPORTS_PER_SOL).toFixed(3)} < ${MIN_CREATOR_SOL}`;
    }
  } catch {
    return "creator balance check failed";
  }
  return null;
}

async function passesCurveFilters(
  connection: Connection,
  curve: BondingCurveAccount,
  meta: CreateMeta | null,
  blacklist: string[]
): Promise<string | null> {
  if (!curve.isSolQuoted()) return "non-SOL quote";
  if (SKIP_MAYHEM && curve.isMayhemMode) return "mayhem mode";
  if (meta && nameBlocked(meta.name, meta.symbol, blacklist)) {
    return `name blacklist (${meta.name}/${meta.symbol})`;
  }
  return creatorSolOk(connection, curve.creator);
}

type SnipeCtx = {
  sdk: PumpFunSDK;
  connection: Connection;
  buyer: Keypair;
  skipMints: Set<string>;
  blacklist: string[];
  seen: Set<string>;
  getSnipeList: () => Set<string>;
  openPositions: { n: number };
  feeRecipient?: PublicKey;
  createSigByMint: Map<string, string>;
  sourceByMint: Map<string, TraceSource>;
  createSlotByMint: Map<string, number>;
  detectedNsByMint: Map<string, string>;
  decodedNsByMint: Map<string, string>;
  _lastSource?: TraceSource;
  _lastCreateSlot?: number;
  _lastDetectedNs?: string;
  _lastDecodedNs?: string;
};

async function handleCreate(
  ctx: SnipeCtx,
  meta: CreateMeta,
  signature: string,
  detect?: {
    source: TraceSource;
    createSlot?: number;
    receivedNs: string;
    decodedNs?: string;
  }
) {
  const { sdk, connection, buyer, skipMints, blacklist, seen, openPositions } =
    ctx;
  const mintStr = meta.mint;
  const source = detect?.source || ctx._lastSource || "txsub";
  const createSlot = detect?.createSlot ?? ctx._lastCreateSlot;
  const detectLite = { source, createSlot };

  try {
    // Telemetry before economic dedupe. A second feed must not create a second trade.
    require("./research/v3-collector.js").noteSource({
      mint: mintStr,
      source,
      observedAt: Date.now(),
      slot: createSlot ?? null,
      creator: meta.creator,
      creatorSource: "create_event",
      deployer: meta.user,
      quoteMint: meta.quoteMint,
      quoteMintSource: meta.quoteMint ? "create_meta" : null,
      createVersion:
        meta.tokenProgram && meta.tokenProgram.includes("Tokenz") ? "create_v2" : "legacy",
      mayhem: meta.isMayhem,
      cashback: meta.intent?.holderReward === true,
      bondingCurve: meta.bondingCurve,
      tokenProgram: meta.tokenProgram,
      createSignature: signature,
    });
  } catch (err) {
    console.warn("[V3] source note failed", (err as Error).message);
  }

  try {
    // Research registration only. In-memory; no RPC and no effect on the decision.
    require("./research/wallet-flow-collector.js").noteCandidate({
      mint: mintStr,
      createSignature: signature,
      creator: meta.creator,
      deployer: meta.user,
      quoteMint: meta.quoteMint,
      mayhem: meta.isMayhem,
      observedAt: Date.now(),
      source,
    });
  } catch (err) {
    console.warn("[wallet-flow] research warning", (err as Error).message);
  }

  if (seen.has(mintStr) || skipMints.has(mintStr)) {
    if (skipMints.has(mintStr)) console.log(`[skip] our mint ${mintStr}`);
    return;
  }
  // Detect age — don't chase stale creates (same-slot posture). HARD reject.
  noteFirstSeen(mintStr);
  if (getCandidateState(mintStr) !== "NEW") return;
  if (meta.timestamp > 1_000_000_000) {
    const ageMs = Date.now() - meta.timestamp * 1000;
    if (MAX_TOKEN_AGE_MS > 0 && ageMs > MAX_TOKEN_AGE_MS) {
      emitSkipDecision(ctx, meta, signature, `stale create ${ageMs}ms`, detectLite);
      return;
    }
  }

  // Score early so reservation policy can use admission score
  let creatorSolEarly: number | undefined;
  const deployerKey = meta.user || meta.intent?.deployer || meta.creator;
  const scoredEarly = scoreCreator(meta.creator, { creatorSol: creatorSolEarly });
  const depEarly = scoreDeployer(deployerKey, {
    currentDevBuySol: meta.intent?.creatorBuySol,
    mint: mintStr,
  });
  const admissionEarly = blendAdmission(scoredEarly, depEarly, W_CREATOR, W_DEPLOYER);

  const reserveReject = mayEnter(openPositions.n, admissionEarly);
  if (reserveReject) {
    emitSkipDecision(ctx, meta, signature, reserveReject, detectLite, {
      noClaim: true,
      creatorSig: scoredEarly,
      deployerSig: depEarly,
      admissionScore: admissionEarly,
    });
    return;
  }
  if (USE_LIST && !ctx.getSnipeList().has(mintStr)) {
    emitSkipDecision(ctx, meta, signature, "not on snipe list", detectLite);
    return;
  }

  const fastReject = eventFilterReject(meta, blacklist, buyer.publicKey);
  if (fastReject) {
    if (fastReject === "we created") {
      skipMints.add(mintStr);
      try {
        fs.appendFileSync(
          path.join(__dirname, "../../wallets/our-mints.txt"),
          mintStr + "\n"
        );
      } catch {
        /* */
      }
    }
    console.log(`[skip] ${fastReject} | ${mintStr}`);
    emitSkipDecision(ctx, meta, signature, fastReject, detectLite);
    return;
  }

  // Creator SOL (best-effort) + cached quality score (memory lookup)
  let creatorSol: number | undefined;
  const solCheck = async () => {
    try {
      const lam = await connection.getBalance(
        new PublicKey(meta.creator),
        "confirmed"
      );
      creatorSol = lam / LAMPORTS_PER_SOL;
      if (MIN_CREATOR_SOL > 0 && creatorSol < MIN_CREATOR_SOL) {
        return `creator SOL ${creatorSol.toFixed(3)} < ${MIN_CREATOR_SOL}`;
      }
    } catch {
      return "creator balance check failed";
    }
    return null;
  };

  if (!EXTREME_FAST) {
    const crej = await solCheck();
    if (crej) {
      console.log(`[skip] ${crej} | ${mintStr}`);
      emitSkipDecision(ctx, meta, signature, crej, detectLite, { creatorSol });
      return;
    }
  } else if (MIN_CREATOR_SOL > 0) {
    const crej = await Promise.race([
      solCheck(),
      new Promise<string | null>((r) => setTimeout(() => r(null), 120)),
    ]);
    if (crej) {
      console.log(`[skip] ${crej} | ${mintStr}`);
      emitSkipDecision(ctx, meta, signature, crej, detectLite, { creatorSol });
      return;
    }
  }

  const entryMcSol = estimateMcSol(
    meta.virtualSolReserves,
    meta.virtualTokenReserves
  );
  const entryMcUsd = entryMcSol * SOL_USD;
  if (MAX_ENTRY_MC_SOL > 0 && entryMcSol > MAX_ENTRY_MC_SOL) {
    const reason = `entry MC ${entryMcSol.toFixed(1)} SOL > max ${MAX_ENTRY_MC_SOL}`;
    console.log(`[skip] ${reason} | ${mintStr}`);
    emitSkipDecision(ctx, meta, signature, reason, detectLite, {
      creatorSol,
      score: scoreCreator(meta.creator, { creatorSol }).score,
    });
    return;
  }

  const deployer = meta.user || meta.intent?.deployer || meta.creator;
  const scored = scoreCreator(meta.creator, { creatorSol });
  const dep = scoreDeployer(deployer, {
    currentDevBuySol: meta.intent?.creatorBuySol,
    mint: mintStr,
  });
  // Score first so kill-gated skips still carry decision-time conviction for shadow research.
  // Does NOT submit a trade. Kill switch behavior unchanged.
  const sel = resolveBuySol({
    deployer: dep,
    creator: scored,
    baseUnits: BASE_UNITS,
    minAdmission: MIN_CREATOR_SCORE,
    liveBuySol: BUY_SOL,
    liveConvictionGate: LIVE_CONVICTION_GATE,
    wCreator: W_CREATOR,
    wDeployer: W_DEPLOYER,
  });
  const kill = expectancyKillSwitch();
  if (kill) {
    console.log(`[kill] ${kill} — skipping entries (shadow labels still collected)`);
    emitSkipDecision(ctx, meta, signature, kill, detectLite, {
      creatorSol,
      creatorSig: scored,
      deployerSig: dep,
      admissionScore: sel.admissionScore,
      sel,
    });
    return;
  }
  if (SHADOW_OBSERVE_ONLY) {
    emitSkipDecision(
      ctx,
      meta,
      signature,
      "shadow_observe_only (insufficient SOL)",
      detectLite,
      {
        creatorSol,
        creatorSig: scored,
        deployerSig: dep,
        admissionScore: sel.admissionScore,
        sel,
      }
    );
    return;
  }

  const admission = sel.admissionScore;
  const buySol = sel.admit ? sel.buySol : BUY_SOL;
  let slotLagHint: number | undefined;
  if (createSlot != null) {
    try {
      slotLagHint = (await connection.getSlot("processed")) - createSlot;
    } catch {
      /* */
    }
  }
  const edge = estimateEdge({
    creator: scored,
    deployer: dep,
    buySol,
    slotDelta: slotLagHint,
  });

  if (!sel.admit) {
    if (getCandidateState(mintStr) !== "NEW") return;
    const reason = sel.reason || "selection reject";
    console.log(
      `[skip] ${reason} | ${mintStr} rawScore=${admission}` +
        ` globalConv=${fmtConvWithN(sel.globalConvPct, sel.globalConvN)}` +
        ` eligibleConv=${fmtConvWithN(
          sel.eligibleConvPct,
          sel.eligibleConvN,
          "eligibleConvWindowN"
        )}`
    );
    emitSkipDecision(ctx, meta, signature, reason, detectLite, {
      creatorSol,
      creatorSig: scored,
      deployerSig: dep,
      admissionScore: admission,
      edge,
      sel,
    });
    return;
  }
  if (MIN_DEPLOYER_SCORE > 0 && dep.score < MIN_DEPLOYER_SCORE) {
    const reason = `deployer score ${dep.score} < ${MIN_DEPLOYER_SCORE}`;
    console.log(`[skip] ${reason} | ${mintStr}`);
    emitSkipDecision(ctx, meta, signature, reason, detectLite, {
      creatorSol,
      creatorSig: scored,
      deployerSig: dep,
      admissionScore: admission,
      edge,
    });
    return;
  }
  if (MIN_EDGE_SOL > 0 && edge.edgeSol < MIN_EDGE_SOL) {
    const reason = `edge ${edge.edgeSol.toFixed(4)} < ${MIN_EDGE_SOL}`;
    console.log(`[skip] ${reason} | ${mintStr}`);
    emitSkipDecision(ctx, meta, signature, reason, detectLite, {
      creatorSol,
      creatorSig: scored,
      deployerSig: dep,
      admissionScore: admission,
      edge,
    });
    return;
  }

  // Re-check reservation with full score
  const reserve2 = mayEnter(openPositions.n, admission);
  if (reserve2) {
    emitSkipDecision(ctx, meta, signature, reserve2, detectLite, {
      noClaim: true,
      creatorSol,
      creatorSig: scored,
      deployerSig: dep,
      admissionScore: admission,
      edge,
    });
    return;
  }

  // Same-slot: if createSlot already lagged before we send, abandon (don't chase)
  if (getCandidateState(mintStr) !== "NEW") return;
  if (createSlot != null && MAX_SLOT_LAG >= 0) {
    try {
      const slotNow = await connection.getSlot("processed");
      const lag = slotNow - createSlot;
      if (lag > MAX_SLOT_LAG) {
        const reason = `slot lag ${lag} > ${MAX_SLOT_LAG}`;
        console.log(`[skip] ${reason} | ${mintStr}`);
        emitSkipDecision(ctx, meta, signature, reason, detectLite, {
          creatorSol,
          creatorSig: scored,
          deployerSig: dep,
          admissionScore: admission,
          edge,
        });
        return;
      }
    } catch {
      /* non-fatal */
    }
  }

  // Decision before claimCreate so prior skips aren't overridden
  if (getCandidateState(mintStr) !== "NEW") return;
  if (!claimDecision(mintStr, "BUYING")) {
    return;
  }
  if (!claimCreate(mintStr, signature)) {
    console.log(`[dedupe] skip ${mintStr.slice(0, 8)}…`);
    return;
  }
  seen.add(mintStr);
  openPositions.n++;
  stats.snipes++;
  const receivedNs =
    detect?.receivedNs || ctx._lastDetectedNs || nowNs().toString();
  const decodedNs = detect?.decodedNs || ctx._lastDecodedNs;
  ctx.createSigByMint.set(mintStr, signature);
  ctx.sourceByMint.set(mintStr, source);
  if (createSlot != null) ctx.createSlotByMint.set(mintStr, createSlot);
  ctx.detectedNsByMint.set(mintStr, receivedNs);
  if (decodedNs) ctx.decodedNsByMint.set(mintStr, decodedNs);
  const filteredNs = nowNs().toString();

  noteCreatorLaunch(meta.creator, mintStr, true, creatorSol);
  noteDeployerLaunch(deployer, mintStr, true, {
    sameTxBuy: meta.intent?.creatorBuyInCreateTx,
    initialBuySol: meta.intent?.creatorBuySol,
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri,
  });
  const buyDecision: DecisionTrace = {
    mint: mintStr,
    creator: meta.creator,
    deployer,
    createSig: signature,
    createSlot,
    source,
    decision: "buy",
    creatorScore: admission,
    creatorScoreUnknown: scored.unknown,
    rawScore: scored.quality,
    effectiveScore: scored.score,
    confidence: scored.confidence,
    creatorN: scored.observations,
    deployerScore: dep.score,
    deployerN: dep.observations,
    deployerLaunches1h: dep.launches1h,
    creatorSol,
    mayhem: meta.isMayhem,
    symbol: meta.symbol,
    name: meta.name,
    sameTxCreatorBuy: meta.intent?.creatorBuyInCreateTx,
    creatorBuySol: meta.intent?.creatorBuySol,
    creatorBuyBucket: creatorBuyBucket(meta.intent?.creatorBuySol),
    cuLimit: meta.intent?.cuLimit,
    cuPriceMicroLamports: meta.intent?.cuPriceMicroLamports,
    numInstructions: meta.intent?.numInstructions,
    numSigners: meta.intent?.numSigners,
    hasAddressLookupTables: meta.intent?.hasAddressLookupTables,
    holderReward: meta.intent?.holderReward,
    tokenProgram: meta.tokenProgram,
    pRunner: edge.pRunner,
    pAdverse: edge.pAdverse,
    expectedPnl30: edge.expectedPnl30,
    edgeSol: edge.edgeSol,
    convictionPct: sel.globalConvPct,
    globalConvPct: sel.globalConvPct,
    eligibleConvPct: sel.eligibleConvPct,
    globalConvN: sel.globalConvN,
    eligibleConvN: sel.eligibleConvN,
    shadowTop5: sel.shadowCohorts.top5,
    shadowTop2: sel.shadowCohorts.top2,
    shadowTop1: sel.shadowCohorts.top1,
    shadowTop05: sel.shadowCohorts.top05,
    shadowTop01: sel.shadowCohorts.top01,
    shadowBuySol: sel.shadowBuySol,
    buyFamily: meta.intent?.buyFamily,
    maxSolCost: meta.intent?.maxSolCost,
    minTokensOut: meta.intent?.minTokensOut,
    encodedSlippageBps: meta.intent?.encodedSlippageBps,
    deployerLaunchesPerDay: sel.core.deployerLaunchesPerDay,
    secsSincePriorLaunch: sel.core.secondsSincePriorLaunch,
    historicalDevBuyMeanSol: sel.core.historicalDevBuyMeanSol,
    deployerPreviouslyProfitable: sel.core.deployerPreviouslyProfitable,
    sampleKind: "live_selected",
    shadowSample: false,
    ts: Date.now(),
    entryMcSol,
    entryMcUsd,
  };
  logDecisionTrace(buyDecision);
  trackDecisionOutcome(sdk, mintStr, meta.creator, buyDecision, deployer);

  console.log(
    `\n>>> SNIPE ${mintStr} (${meta.symbol}) adm=${admission} rawScore=${admission} dep=${dep.score} branch=${dep.branch} size=${buySol.toFixed(4)}` +
      ` globalConv=${fmtConvWithN(sel.globalConvPct, sel.globalConvN)}` +
      ` eligibleConv=${fmtConvWithN(
        sel.eligibleConvPct,
        sel.eligibleConvN,
        "eligibleConvWindowN"
      )}` +
      ` shadowSize=${sel.shadowBuySol.toFixed(3)} edge=${edge.edgeSol.toFixed(4)}` +
      ` top[${[
        sel.shadowCohorts.top5 && "5",
        sel.shadowCohorts.top2 && "2",
        sel.shadowCohorts.top1 && "1",
        sel.shadowCohorts.top05 && "0.5",
        sel.shadowCohorts.top01 && "0.1",
      ]
        .filter(Boolean)
        .join("|") || "none"}]` +
      (meta.intent?.buyFamily ? ` buyFam=${meta.intent.buyFamily}` : "") +
      (createSlot != null ? ` createSlot=${createSlot}` : "") +
      (meta.intent?.creatorBuyInCreateTx
        ? ` sameTxBuy=${(meta.intent.creatorBuySol ?? 0).toFixed(3)}`
        : "")
  );
  console.log(
    "    deployer",
    deployer,
    "creator",
    meta.creator,
    "sig",
    signature,
    dep.reasons.join(","),
    "|",
    scored.reasons.join(",")
  );

  try {
    const mint = new PublicKey(mintStr);

    if (!EXTREME_FAST) {
      // Safe path: wait for on-chain curve + re-check filters
      const curve = await waitForCurve(sdk, mint, 40);
      if (!curve) {
        console.log(`[skip] no curve ${mintStr}`);
        return;
      }
      const reason = await passesCurveFilters(
        connection,
        curve,
        meta,
        blacklist
      );
      if (reason) {
        console.log(`[skip] ${reason} | ${mintStr}`);
        return;
      }
    }

    // Extreme-fast: fire from CreateEvent (no waitForCurve). Retries cover
    // ConstraintSeeds if create hasn't propagated to the leader yet.
    const bought = await buyMint(
      sdk,
      connection,
      buyer,
      mint,
      buySol,
      meta,
      ctx.feeRecipient,
      {
        source,
        createSig: signature,
        createSlot,
        receivedNs,
        decodedNs,
        filteredNs,
        firstSeenMs: noteFirstSeen(mintStr),
      }
    );
    if (bought.success) {
      await monitorAndExit(
        sdk,
        connection,
        buyer,
        mint,
        buySol,
        signature,
        source,
        admission
      );
    } else {
      try {
        const mintInfo = await connection.getAccountInfo(mint, "confirmed");
        if (mintInfo) {
          const { ata } = tokenAta(mint, buyer.publicKey, mintInfo.owner);
          const bal = await connection.getTokenAccountBalance(ata);
          if (BigInt(bal.value.amount) > 0n) {
            console.log(`[buy] recovered ATA balance ${bal.value.uiAmountString}`);
            await monitorAndExit(
              sdk,
              connection,
              buyer,
              mint,
              buySol,
              signature,
              source,
              admission
            );
          }
        }
      } catch {
        /* no position */
      }
    }
  } catch (e) {
    console.error("[position] err", e);
  } finally {
    openPositions.n--;
  }
}

/**
 * Resolve Yellowstone / LaserStream endpoint.
 * Helius LaserStream mainnet needs Business plan; Chainstack geyser works with any
 * geyser-enabled node (see chainstack-grpc-geyser-tutorial).
 */
function resolveGeyserConfig(): {
  endpoint: string;
  token: string;
  source: string;
} | null {
  const explicit = process.env.GEYSER_ENDPOINT?.trim();
  const tokenEnv = process.env.GEYSER_API_TOKEN?.trim();
  if (explicit) {
    return {
      endpoint: explicit,
      token: tokenEnv || "",
      source: "GEYSER_ENDPOINT",
    };
  }

  const rpc =
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT ||
    "";
  const key = (rpc.match(/api-key=([^&]+)/i) || [])[1];
  if (!key) return null;

  // Closest default US-East LaserStream (yellowstone-compatible)
  const region = (process.env.HELIUS_LASERSTREAM_REGION || "ewr").toLowerCase();
  const endpoint =
    process.env.HELIUS_LASERSTREAM_URL ||
    `https://laserstream-mainnet-${region}.helius-rpc.com`;
  return {
    endpoint,
    token: tokenEnv || key,
    source: `helius-laserstream:${region}`,
  };
}

/**
 * Helius preprocessedSubscribe @ beta WSS — ~8ms before processed.
 * Docs: https://www.helius.dev/docs/preprocessed-transactions/preprocessed-subscribe
 * Binary frame: version u8 | slot u64 LE | sig 64 | wire tx
 * Curve may not exist yet → 2006 is an expected race, not a soft skip.
 */
async function startPreprocessedListener(ctx: SnipeCtx): Promise<boolean> {
  const keyMatch = (
    process.env.HELIUS_RPC_URL ||
    process.env.RPC_ENDPOINT ||
    ""
  ).match(/api-key=([^&]+)/i);
  const apiKey =
    process.env.HELIUS_API_KEY ||
    (keyMatch && keyMatch[1]) ||
    "";
  if (!apiKey) {
    console.log("[pre] no Helius API key — skip");
    return false;
  }

  let WebSocketCtor: any;
  try {
    WebSocketCtor = require("ws");
  } catch {
    console.warn("[pre] ws missing");
    return false;
  }

  const wsUrl =
    process.env.HELIUS_BETA_WSS ||
    `wss://beta.helius-rpc.com/?api-key=${apiKey}`;

  return await new Promise<boolean>((resolve) => {
    const sock = new WebSocketCtor(wsUrl);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timeout = setTimeout(() => {
      console.warn("[pre] subscribe timeout — skip");
      try {
        sock.close();
      } catch {
        /* */
      }
      done(false);
    }, 8000);

    sock.on("open", () => {
      console.log(
        "Listener: Helius preprocessedSubscribe (beta WSS, pre-execution)"
      );
      sock.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "preprocessedSubscribe",
          params: {
            accountInclude: [PUMP_PROGRAM.toBase58()],
            accountExclude: [],
            accountRequired: [],
          },
        })
      );
      const ping = setInterval(() => {
        if (sock.readyState === WebSocketCtor.OPEN) {
          try {
            sock.ping();
          } catch {
            /* */
          }
        }
      }, 30_000);
      sock.on("close", () => clearInterval(ping));
    });

    sock.on("message", (data: Buffer | string, isBinary?: boolean) => {
      const binary =
        isBinary === true ||
        (typeof isBinary === "undefined" && Buffer.isBuffer(data) && !data.toString().startsWith("{"));

      if (!binary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            clearTimeout(timeout);
            if (msg.error) {
              console.error(
                "[pre] subscribe error:",
                msg.error.message || JSON.stringify(msg.error)
              );
              done(false);
              return;
            }
            console.log("[pre] subscribed id=", msg.result);
            done(true);
          }
        } catch {
          /* */
        }
        return;
      }

      try {
        const receivedNs = nowNs();
        const flowObservedAt = Date.now();
        const frame = parsePreprocessedFrame(Buffer.from(data as Buffer));
        if (!frame) return;
        const decoded = decodeCreateFromWireTx(frame.txBytes, PUMP_PROGRAM);
        const flowBytes = Buffer.from(frame.txBytes);
        const noteFlowWire = () => {
          setImmediate(() => {
            try {
              require("./research/wallet-flow-collector.js").noteWireTransaction({
                bytes: flowBytes,
                txSignature: frame.signature,
                slot: frame.slot,
                source: "helius_preprocessed",
                observedAt: flowObservedAt,
              });
            } catch (err) {
              console.warn("[wallet-flow] research warning", (err as Error).message);
            }
          });
          enqueueTimingClock({
            txSignature: frame.signature,
            slot: frame.slot,
            source: "helius_preprocessed",
            observedAt: flowObservedAt,
          });
        };
        if (!decoded) {
          noteFlowWire();
          return;
        }
        const decodedNs = nowNs();

        // Light filters only — no CreateEvent mayhem/quote flags on pre-exec
        if (ctx.skipMints.has(decoded.mint)) return;
        if (nameBlocked(decoded.name, decoded.symbol, ctx.blacklist)) return;
        if (
          decoded.creator === ctx.buyer.publicKey.toBase58()
        ) {
          return;
        }

        const meta: CreateMeta = {
          mint: decoded.mint,
          name: decoded.name,
          symbol: decoded.symbol,
          uri: decoded.uri,
          bondingCurve: decoded.bondingCurve || "",
          user: decoded.deployer || decoded.creator,
          creator: decoded.creator,
          intent: decoded.intent,
          timestamp: Math.floor(Date.now() / 1000),
          // Default pump curve reserves (pre-exec — no CreateEvent meta yet)
          virtualTokenReserves: 1_073_000_000_000_000n,
          virtualSolReserves: 30_000_000_000n,
          realTokenReserves: 793_100_000_000_000n,
          tokenProgram:
            decoded.tokenProgram ||
            (decoded.isV2
              ? TOKEN_2022_PROGRAM_ID
              : TOKEN_PROGRAM_ID
            ).toBase58(),
          isMayhem: false,
          quoteMint: WSOL,
        };

        // Fire buy path; 2006 expected race if curve not live yet
        handleCreate(ctx, meta, frame.signature, {
          source: "preprocessed",
          createSlot: frame.slot,
          receivedNs: receivedNs.toString(),
          decodedNs: decodedNs.toString(),
        }).catch((e) => console.error("[pre] handle", e));
        noteFlowWire();
      } catch (e) {
        console.error("[pre] parse err", e);
      }
    });

    sock.on("error", (e: Error) => {
      console.error("[pre] socket error:", e.message);
      clearTimeout(timeout);
      done(false);
    });

    sock.on("close", () => {
      console.warn("[pre] socket closed — restart sniper to reconnect");
    });
  });
}


function enqueueTimingClock(input: {
  txSignature?: string | null;
  mint?: string | null;
  slot?: number | null;
  source: string;
  observedAt: number;
}) {
  const captured = {
    txSignature: input.txSignature || null,
    mint: input.mint || null,
    slot: input.slot == null ? null : input.slot,
    source: input.source,
    observedAt: input.observedAt,
  };
  setImmediate(() => {
    try {
      require("./research/timing-frontier-collector.js").noteSourceClock(captured);
    } catch (err) {
      console.warn("[timing] research warning", (err as Error).message);
    }
  });
}

function enqueueWalletFlow(input: {
  logs?: string[];
  bytes?: Buffer | null;
  txSignature?: string | null;
  slot?: number;
  source: string;
  observedAt: number;
  loadedWritable?: string[];
  loadedReadonly?: string[];
}) {
  const captured = {
    logs: input.logs ? input.logs.slice() : [],
    bytes: input.bytes ? Buffer.from(input.bytes) : null,
    txSignature: input.txSignature || null,
    slot: input.slot,
    source: input.source,
    observedAt: input.observedAt,
    loadedWritable: input.loadedWritable,
    loadedReadonly: input.loadedReadonly,
  };
  setImmediate(() => {
    try {
      const collector = require("./research/wallet-flow-collector.js");
      if (captured.logs.length) {
        collector.noteLogs({
          logs: captured.logs,
          txSignature: captured.txSignature,
          slot: captured.slot,
          source: captured.source,
          observedAt: captured.observedAt,
        });
      }
      if (captured.bytes) {
        collector.noteWireTransaction({
          bytes: captured.bytes,
          txSignature: captured.txSignature,
          slot: captured.slot,
          source: captured.source,
          observedAt: captured.observedAt,
          loadedWritable: captured.loadedWritable,
          loadedReadonly: captured.loadedReadonly,
        });
      }
    } catch (err) {
      console.warn("[wallet-flow] research warning", (err as Error).message);
    }
  });
}

async function startLogsListener(ctx: SnipeCtx) {
  console.log("Listener: logsSubscribe @ confirmed (Helius WS)");
  ctx.connection.onLogs(
    PUMP_PROGRAM,
    async ({ logs, err, signature }) => {
      if (err) return;
      const flowObservedAt = Date.now();
      enqueueWalletFlow({
        logs,
        txSignature: signature,
        source: "logs",
        observedAt: flowObservedAt,
      });
      enqueueTimingClock({
        txSignature: signature,
        source: "logs",
        observedAt: flowObservedAt,
      });
      if (!isPumpCreateLog(logs)) return;
      const receivedNs = nowNs();
      const meta = parseCreateEvent(logs);
      if (!meta) return;
      handleCreate(ctx, meta, signature, {
        source: "logs",
        receivedNs: receivedNs.toString(),
        decodedNs: nowNs().toString(),
      }).catch((e) => console.error("listener error", e));
    },
    "confirmed"
  );
}

/**
 * Helius enhanced WebSocket transactionSubscribe @ processed.
 * Available on Developer (as of Apr 2026) — cheaper speed unlock than
 * LaserStream gRPC (Business). Docs:
 * https://www.helius.dev/docs/api-reference/rpc/websocket/transactionsubscribe
 */
async function startTxSubscribeListener(ctx: SnipeCtx): Promise<boolean> {
  const wsUrl =
    process.env.RPC_WEBSOCKET_ENDPOINT ||
    process.env.HELIUS_RPC_URL?.replace(/^https/, "wss");
  if (!wsUrl?.startsWith("ws")) {
    console.log("[txsub] no WSS URL — skip");
    return false;
  }

  let WebSocketCtor: any;
  try {
    WebSocketCtor = require("ws");
  } catch {
    console.warn("[txsub] ws package missing");
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const sock = new WebSocketCtor(wsUrl);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      console.warn("[txsub] subscribe ack timeout — falling back");
      try {
        sock.close();
      } catch {
        /* */
      }
      done(false);
    }, 8000);

    sock.on("open", () => {
      console.log(
        "Listener: Helius transactionSubscribe @ processed (Developer enhanced WSS)"
      );
      ctx._lastSource = "txsub";
      sock.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "transactionSubscribe",
          params: [
            {
              accountInclude: [PUMP_PROGRAM.toBase58()],
              failed: false,
              vote: false,
            },
            {
              commitment: "processed",
              encoding: "base64",
              transactionDetails: "full",
              showRewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ],
        })
      );
      // keep-alive (Helius 10min idle timer)
      const ping = setInterval(() => {
        if (sock.readyState === WebSocketCtor.OPEN) {
          try {
            sock.ping();
          } catch {
            sock.send(
              JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })
            );
          }
        }
      }, 50_000);
      sock.on("close", () => clearInterval(ping));
    });

    sock.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.id === 1) {
        clearTimeout(timeout);
        if (msg.error) {
          console.error(
            "[txsub] subscribe error:",
            msg.error.message || JSON.stringify(msg.error)
          );
          done(false);
          return;
        }
        console.log("[txsub] subscribed id=", msg.result);
        done(true);
        return;
      }

      if (msg.method !== "transactionNotification") return;
      const flowObservedAt = Date.now();
      try {
        const receivedNs = nowNs();
        const result = msg.params?.result;
        if (!result) return;
        const sig = result.signature || "";
        const slot =
          typeof result.slot === "number"
            ? result.slot
            : typeof result.context?.slot === "number"
              ? result.context.slot
              : undefined;
        const tx = result.transaction;
        const logs: string[] =
          tx?.meta?.logMessages ||
          tx?.transaction?.meta?.logMessages ||
          [];
        let meta: CreateMeta | null = null;
        if (logs.length && isPumpCreateLog(logs)) {
          meta = parseCreateEvent(logs);
        }
        // Fallback: decode create ix from wire when logs missing
        if (!meta) {
          try {
            const raw =
              typeof tx?.transaction === "string"
                ? tx.transaction
                : Array.isArray(tx?.transaction)
                  ? tx.transaction[0]
                  : typeof tx?.transaction?.transaction?.[0] === "string"
                    ? tx.transaction.transaction[0]
                    : null;
            if (raw) {
              const bytes = Buffer.from(raw, "base64");
              const decoded = decodeCreateFromWireTx(bytes, PUMP_PROGRAM);
              if (decoded) {
                meta = {
                  mint: decoded.mint,
                  name: decoded.name,
                  symbol: decoded.symbol,
                  uri: decoded.uri,
                  bondingCurve: decoded.bondingCurve || "",
                  user: decoded.deployer || decoded.creator,
                  creator: decoded.creator,
                  intent: decoded.intent,
                  timestamp: Math.floor(Date.now() / 1000),
                  virtualTokenReserves: 1_073_000_000_000_000n,
                  virtualSolReserves: 30_000_000_000n,
                  realTokenReserves: 793_100_000_000_000n,
                  tokenProgram:
                    decoded.tokenProgram ||
                    (decoded.isV2
                      ? TOKEN_2022_PROGRAM_ID
                      : TOKEN_PROGRAM_ID
                    ).toBase58(),
                  isMayhem: false,
                  quoteMint: WSOL,
                };
              }
            }
          } catch {
            /* */
          }
        }
        const txRaw =
          typeof tx?.transaction === "string"
            ? tx.transaction
            : Array.isArray(tx?.transaction)
              ? tx.transaction[0]
              : typeof tx?.transaction?.transaction?.[0] === "string"
                ? tx.transaction.transaction[0]
                : null;
        const flowBytes = txRaw ? Buffer.from(txRaw, "base64") : null;
        setImmediate(() => {
          try {
            const collector = require("./research/wallet-flow-collector.js");
            if (logs.length) {
              collector.noteLogs({
                logs,
                txSignature: sig || null,
                slot,
                source: "helius_processed",
                observedAt: flowObservedAt,
              });
            }
            if (flowBytes) {
              collector.noteWireTransaction({
                bytes: flowBytes,
                txSignature: sig || null,
                slot,
                source: "helius_processed",
                observedAt: flowObservedAt,
              });
            }
          } catch (err) {
            console.warn("[wallet-flow] research warning", (err as Error).message);
          }
        });
        enqueueTimingClock({
          txSignature: sig || null,
          slot,
          source: "helius_processed",
          observedAt: flowObservedAt,
        });
        if (!meta) return;
        handleCreate(ctx, meta, sig || "txsub", {
          source: "txsub",
          createSlot: slot,
          receivedNs: receivedNs.toString(),
          decodedNs: nowNs().toString(),
        }).catch((e) => console.error("txsub handle error", e));
      } catch (e) {
        console.error("[txsub] parse err", e);
      }
    });

    sock.on("error", (e: Error) => {
      console.error("[txsub] socket error:", e.message);
      clearTimeout(timeout);
      done(false);
    });

    sock.on("close", () => {
      console.warn("[txsub] socket closed — restart sniper to reconnect");
    });
  });
}

/**
 * Yellowstone gRPC @ processed — same pattern as
 * github.com/chainstacklabs/grpc-geyser-tutorial
 * Works with Chainstack Geyser or Helius LaserStream (Business).
 */
async function startGeyserListener(ctx: SnipeCtx): Promise<boolean> {
  const cfg = resolveGeyserConfig();
  if (!cfg) {
    console.log("[geyser] no endpoint/token — falling back to logs");
    return false;
  }

  let Client: any;
  let CommitmentLevel: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const y = require("@triton-one/yellowstone-grpc");
    Client = y.default;
    CommitmentLevel = y.CommitmentLevel;
  } catch {
    console.warn(
      "[geyser] @triton-one/yellowstone-grpc missing — falling back to logs"
    );
    return false;
  }

  console.log(
    `Listener: Yellowstone gRPC @ PROCESSED (${cfg.source} → ${cfg.endpoint})`
  );

  try {
    const client = new Client(cfg.endpoint, cfg.token, {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });

    const stream = await client.subscribe();
    const req: any = {
      accounts: {},
      slots: {},
      transactions: {
        pump: {
          vote: false,
          failed: false,
          accountInclude: [PUMP_PROGRAM.toBase58()],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel?.PROCESSED ?? "processed",
      accountsDataSlice: [],
    };

    await new Promise<void>((resolve, reject) => {
      stream.write(req, (err: Error | null) => (err ? reject(err) : resolve()));
    });

    let updates = 0;
    stream.on("data", (data: any) => {
      try {
        const wrap = data?.transaction;
        if (!wrap) return;
        updates++;
        if (updates === 1) {
          console.log("[geyser] first transaction update received");
        }

        const info = wrap.transaction || wrap;
        const metaLogs: string[] =
          info.meta?.logMessages ||
          info.meta?.log_messages ||
          wrap.meta?.logMessages ||
          [];
        let sig = "geyser";
        try {
          const rawSig =
            info.signature ||
            wrap.signature ||
            info.transaction?.signatures?.[0];
          if (rawSig) {
            sig = bs58.encode(
              Buffer.isBuffer(rawSig) ? rawSig : Buffer.from(rawSig)
            );
          }
        } catch {
          /* keep geyser */
        }
        const flowObservedAt = Date.now();
        enqueueWalletFlow({
          logs: metaLogs,
          txSignature: sig,
          source: "geyser",
          observedAt: flowObservedAt,
        });
        enqueueTimingClock({
          txSignature: sig,
          source: "geyser",
          observedAt: flowObservedAt,
        });
        if (!metaLogs.length || !isPumpCreateLog(metaLogs)) return;
        const meta = parseCreateEvent(metaLogs);
        if (!meta) return;

        const receivedNs = nowNs();
        handleCreate(ctx, meta, sig, {
          source: "geyser",
          receivedNs: receivedNs.toString(),
          decodedNs: nowNs().toString(),
        }).catch((e) => console.error("geyser handle error", e));
      } catch (e) {
        console.error("[geyser] parse err", e);
      }
    });

    stream.on("error", (e: any) => {
      const msg = e?.details || e?.message || String(e);
      console.error(`[geyser] stream error: ${msg}`);
      if (/unsupported plan/i.test(msg)) {
        console.error(
          "[geyser] Helius LaserStream mainnet needs Business (or use a Chainstack Geyser URL)."
        );
        console.error(
          "[geyser] Falling back — prefer transactionSubscribe on Developer before paying for gRPC."
        );
        startLogsListener(ctx);
      }
    });

    console.log("[geyser] subscribed to pump creates @ processed");
    return true;
  } catch (e: any) {
    const msg = e?.details || e?.message || String(e);
    console.error(`[geyser] connect failed: ${msg}`);
    if (/unsupported plan/i.test(msg)) {
      console.error(
        "[geyser] Helius plan does not include LaserStream mainnet (need Business)."
      );
    }
    console.error(
      "[geyser] Tip: set GEYSER_ENDPOINT + GEYSER_API_TOKEN from Chainstack geyser, or upgrade Helius."
    );
    return false;
  }
}

function startTimingStateLane(ctx: SnipeCtx) {
  let subId: number | null = null;
  const subscribe = () => {
    try {
      if (subId != null) {
        try {
          ctx.connection.removeOnLogsListener(subId);
        } catch {
          /* already dropped */
        }
      }
      subId = ctx.connection.onLogs(
        PUMP_PROGRAM,
        (info, context) => {
          if (info.err) return;
          const observedAt = Date.now();
          const slot = context && typeof context.slot === "number" ? context.slot : null;
          const logs = info.logs ? info.logs.slice() : [];
          const txSignature = info.signature || null;
          setImmediate(() => {
            try {
              require("./research/timing-frontier-collector.js").noteLogs({
                logs,
                txSignature,
                slot,
                source: "processed_logs",
                observedAt,
              });
            } catch (err) {
              console.warn("[timing] research warning", (err as Error).message);
            }
          });
        },
        "processed"
      );
      console.log("[timing] research logsSubscribe @ processed id=" + subId);
    } catch (err) {
      console.warn("[timing] research warning", (err as Error).message);
      setTimeout(subscribe, 5000);
    }
  };
  subscribe();
  const ws = (ctx.connection as any)._rpcWebSocket;
  if (ws && typeof ws.on === "function") {
    ws.on("close", () => {
      console.warn("[timing] research warning socket closed; reconnect");
      setTimeout(subscribe, 2000);
    });
  }
}

async function main() {
  const rpc =
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT;
  const ws = process.env.RPC_WEBSOCKET_ENDPOINT;
  const pk = process.env.PRIVATE_KEY;
  if (!rpc || !pk) {
    console.error("Need RPC + PRIVATE_KEY");
    process.exit(1);
  }

  let snipeList = loadSnipeList();
  const skipMints = loadSkipMints();
  const blacklist = loadNameBlacklist();

  const buyer = Keypair.fromSecretKey(bs58.decode(pk));
  const connection = new Connection(rpc, {
    wsEndpoint: ws,
    commitment: "confirmed",
  });
  try {
    const v3 = require("./research/v3-collector.js");
    const curveMath = require("./research/valuation/curve.js");
    v3.attachCurveFetcher(async (address: string) => {
      const info = await connection.getAccountInfo(new PublicKey(address), "processed");
      if (!info?.data) return null;
      const acct = BondingCurveAccount.fromBuffer(Buffer.from(info.data));
      const state = {
        virtualSolReserves: Number(acct.virtualSolReserves),
        virtualTokenReserves: Number(acct.virtualTokenReserves),
        realSolReserves: Number(acct.realSolReserves),
        realTokenReserves: Number(acct.realTokenReserves),
        complete: acct.complete,
      };
      return {
        virtualSolReserves: state.virtualSolReserves,
        virtualTokenReserves: state.virtualTokenReserves,
        realSolReserves: state.realSolReserves,
        realTokenReserves: state.realTokenReserves,
        curveProgress: curveMath.getBondingProgress(state),
        spotPrice: curveMath.getTokenPriceSol(state),
      };
    });
  } catch (err) {
    console.warn("[V3] curve fetcher not attached", (err as Error).message);
  }
  const sdk = new PumpFunSDK(
    new AnchorProvider(connection, new NodeWallet(Keypair.generate()), {
      commitment: "confirmed",
    })
  );

  const bal = await connection.getBalance(buyer.publicKey);
  let feeRecipient: PublicKey | undefined;
  try {
    feeRecipient = (await sdk.getGlobalAccount("processed")).feeRecipient;
  } catch {
    /* buyFromCreateEvent will fetch per-tx */
  }

  console.log("=== UNIFIED pump sniper ===");
  console.log("wallet:", buyer.publicKey.toBase58());
  console.log("balance:", (bal / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log(
    `buy baseUnit=${UNIT_SOL.toFixed(6)} SOL (4/81) ×${BASE_UNITS} | conviction=${CONVICTION_SIZING} | extreme_fast=${EXTREME_FAST} | dynamic_fee=${DYNAMIC_FEE}`
  );
  console.log(
    `exit mode=${EXIT_MODE} TP=${TAKE_PROFIT_PCT || "off"} SL=-${STOP_LOSS_PCT || "off"}(catastrophic) hold ${MAX_HOLD_MS}ms | concurrent=${MAX_CONCURRENT} maxAge=${MAX_TOKEN_AGE_MS}ms maxSlotLag=${MAX_SLOT_LAG}`
  );
  console.log(
    `filters: SOL-only, skipMayhem=${SKIP_MAYHEM}, minCreator=${MIN_CREATOR_SOL}, maxAgeMs=${MAX_TOKEN_AGE_MS}`
  );
  loadCreatorCache();
  startCreatorCacheFlusher(30_000);
  loadDeployerCache();
  startDeployerCacheFlusher(30_000);
  resetPromotionWindows("post_fix");
  console.log(
    `[research] segment=${RESEARCH.sampleSegment} model=${RESEARCH.modelVersion} stateFix=${RESEARCH.stateFixVersion} pctWin=${RESEARCH.percentileWindowVersion} minPromotionConvN=${MIN_PROMOTION_CONV_N}`
  );
  console.log("listener mode:", LISTENER);
  console.log(
    `admission gate=${MIN_CREATOR_SCORE || "off"} deployerGate=${MIN_DEPLOYER_SCORE || "off"} reserve=${RESERVE_SLOTS}@${HIGH_PRIORITY_SCORE} farm1h>=${MAX_DEPLOYER_LAUNCHES_1H} edge=${MIN_EDGE_SOL || "shadow"} dead=${DEAD_EXIT ? "exit" : DEAD_SHADOW ? "shadow" : "off"} sample=${DECISION_SAMPLE} maxEntryMc=${MAX_ENTRY_MC_SOL}SOL`
  );
  console.log("skip our:", [...skipMints].join(", ") || "(none)");

  const buyNow = arg("buy-now");
  if (buyNow) {
    const mint = new PublicKey(buyNow);
    await buyMint(sdk, connection, buyer, mint, BUY_SOL, undefined, feeRecipient);
    await monitorAndExit(sdk, connection, buyer, mint, BUY_SOL);
    if (!process.argv.includes("--listen")) return;
  }

  if (bal < UNIT_SOL * BASE_UNITS * 2 * LAMPORTS_PER_SOL + MIN_RESERVE_SOL * LAMPORTS_PER_SOL) {
    SHADOW_OBSERVE_ONLY = true;
    console.warn(
      `[research] insufficient SOL (${(bal / LAMPORTS_PER_SOL).toFixed(4)}) — SHADOW_OBSERVE_ONLY (no buys; counterfactual labels continue)`
    );
  }

  const ctx: SnipeCtx = {
    sdk,
    connection,
    buyer,
    skipMints,
    blacklist,
    seen: new Set(),
    getSnipeList: () => snipeList,
    openPositions: { n: 0 },
    feeRecipient,
    createSigByMint: new Map(),
    sourceByMint: new Map(),
    createSlotByMint: new Map(),
    detectedNsByMint: new Map(),
    decodedNsByMint: new Map(),
  };

  console.log(
    "send mode:",
    SEND_MODE,
    "tipLamports=",
    senderTipLamports(SEND_MODE)
  );

  // auto: preprocessed (extreme) + tx@processed (reconciliation) in parallel;
  // then geyser → logs. Dedupe via claimCreate(mint/sig).
  // Tutorial ref: https://github.com/chainstacklabs/grpc-geyser-tutorial
  let preOk = false;
  let txOk = false;
  let geyserOk = false;

  if (LISTENER === "preprocessed" || LISTENER === "auto") {
    preOk = await startPreprocessedListener(ctx);
  }
  if (
    LISTENER === "tx" ||
    LISTENER === "txsub" ||
    LISTENER === "auto" // always keep processed stream as authority when auto
  ) {
    txOk = await startTxSubscribeListener(ctx);
  }
  if (
    LISTENER === "geyser" ||
    (LISTENER === "auto" && !preOk && !txOk && process.env.GEYSER_ENDPOINT)
  ) {
    geyserOk = await startGeyserListener(ctx);
  }
  if (!preOk && !txOk && !geyserOk) {
    console.log("[listener] falling back to logsSubscribe");
    await startLogsListener(ctx);
  } else {
    console.log(
      `[listener] active pre=${preOk} txsub=${txOk} geyser=${geyserOk}`
    );
  }

  try {
    startTimingStateLane(ctx);
  } catch (err) {
    console.warn("[timing] research warning", (err as Error).message);
  }

  setInterval(() => {
    snipeList = loadSnipeList();
    printStats();
  }, Number(process.env.SNIPE_LIST_REFRESH_INTERVAL || 20000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
