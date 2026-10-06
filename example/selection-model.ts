/**
 * Selection + conviction — research instrument.
 * Live: soft floor collection + catastrophic farm reject.
 * Shadow: global vs eligible percentiles; top 5/2/1/0.5/0.1 cohorts.
 * Kill: profitability AND discrimination health.
 */
import { CreatorSignal } from "./creator-cache";
import { DeployerSignal } from "./deployer-cache";

export const UNIT_SOL = 4 / 81;

export interface CoreAdmissionFeatures {
  deployerPreviouslyProfitable: number;
  deployerLaunchesPerDay: number;
  secondsSincePriorLaunch: number;
  historicalDevBuyMeanSol: number;
  currentDevBuySol: number;
  deployerObservations: number;
  launches5m: number;
  launches1h: number;
  launches24h: number;
  launches7d: number;
  medianInterLaunchSeconds: number | null;
}

const EMPTY_COHORTS = {
  top5: false,
  top2: false,
  top1: false,
  top05: false,
  top01: false,
};

export type SelectionDecision = {
  admit: boolean;
  reason?: string;
  admissionScore: number;
  /** Empirical CDF rank among ALL structurally valid scored launches (null until n>=5) */
  globalConvPct: number | null;
  /** Empirical CDF rank among soft-floor-eligible population only */
  eligibleConvPct: number | null;
  convictionPct: number | null; // alias of globalConvPct for back-compat
  convictionFrac: number;
  sizeMult: number;
  buySol: number;
  units: number;
  shadowCohorts: {
    top5: boolean;
    top2: boolean;
    top1: boolean;
    top05: boolean;
    top01: boolean;
  };
  /** Cohorts by eligible denominator (explicit) */
  eligibleShadowCohorts: {
    top5: boolean;
    top2: boolean;
    top1: boolean;
    top05: boolean;
    top01: boolean;
  };
  shadowBuySol: number;
  core: CoreAdmissionFeatures;
  /** Window sizes used for the CDF ranks (for logging) */
  globalConvN?: number;
  eligibleConvN?: number;
};

const recentGlobal: number[] = [];
const recentEligible: number[] = [];
const MAX_RECENT = 800;

/** Min empirical CDF denominator before shadow top-% flags count for promotion */
export const MIN_PROMOTION_CONV_N = Number(
  process.env.SNIPE_MIN_PROMOTION_CONV_N || "100"
);

type ExitObs = {
  ts: number;
  pnlPct: number;
  admissionScore: number;
  runner: boolean; // execMFE>=10 or pnl>0
};
const recentExits: ExitObs[] = [];

/** Start a clean post-fix promotion window (scores + exit health). */
export function resetPromotionWindows(reason = "post_fix"): void {
  recentGlobal.length = 0;
  recentEligible.length = 0;
  recentExits.length = 0;
  console.log(
    `[research] reset promotion windows (${reason}) minConvN=${MIN_PROMOTION_CONV_N}`
  );
}

export function noteGlobalScore(score: number): void {
  recentGlobal.push(score);
  if (recentGlobal.length > MAX_RECENT) recentGlobal.shift();
}

export function noteEligibleScore(score: number): void {
  recentEligible.push(score);
  if (recentEligible.length > MAX_RECENT) recentEligible.shift();
}

/** @deprecated use noteGlobalScore */
export function noteAdmissionScore(score: number): void {
  noteGlobalScore(score);
}

export function noteExitPnl(
  pnlPct: number,
  extra?: { admissionScore?: number; execMfePct?: number }
): void {
  const runner =
    pnlPct > 0 ||
    (typeof extra?.execMfePct === "number" && extra.execMfePct >= 10);
  recentExits.push({
    ts: Date.now(),
    pnlPct,
    admissionScore: extra?.admissionScore ?? 50,
    runner,
  });
  if (recentExits.length > 500) recentExits.shift();
}

function percentileIn(window: number[], score: number): number | null {
  // Empirical CDF only — never alias raw score as a percentile.
  if (window.length < 5) return null;
  const sorted = [...window].sort((a, b) => a - b);
  // upper_bound: count of scores strictly < score, plus half-ties ≈ rank of last <= score
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= score) lo = mid + 1;
    else hi = mid;
  }
  return (100 * lo) / sorted.length;
}

export function convictionPercentile(score: number): number | null {
  return percentileIn(recentGlobal, score);
}

export function eligibleConvictionPercentile(score: number): number | null {
  return percentileIn(recentEligible, score);
}

export function globalConvWindowSize(): number {
  return recentGlobal.length;
}

export function eligibleConvWindowSize(): number {
  return recentEligible.length;
}

export function blendAdmission(
  creator: CreatorSignal,
  deployer: DeployerSignal,
  wCreator = 0.15,
  wDeployer = 0.85
): number {
  const wc = Math.max(0, wCreator);
  const wd = Math.max(0, wDeployer);
  const w = wc + wd || 1;
  return Math.round((creator.score * wc + deployer.score * wd) / w);
}

export function extractCoreFeatures(dep: DeployerSignal): CoreAdmissionFeatures {
  return {
    deployerPreviouslyProfitable:
      dep.boughtDeployerBefore && (dep.positiveMfe30Rate ?? 0) >= 0.4
        ? 1
        : dep.boughtDeployerBefore
          ? 0.5
          : 0,
    deployerLaunchesPerDay: dep.launchesPerDay,
    secondsSincePriorLaunch: dep.secsSincePriorLaunch ?? -1,
    historicalDevBuyMeanSol: dep.prevDevBuyMean ?? 0,
    currentDevBuySol: dep.currentDevBuySol ?? 0,
    deployerObservations: dep.observations,
    launches5m: dep.launches5m ?? 0,
    launches1h: dep.launches1h,
    launches24h: dep.launches24h,
    launches7d: dep.launches7d,
    medianInterLaunchSeconds: dep.medianInterLaunchSeconds ?? null,
  };
}

export function deployerStructuralReject(dep: DeployerSignal): string | null {
  if (dep.launches1h >= 10) return `deployer farm ${dep.launches1h}/1h`;
  if (dep.launchesPerDay >= 12)
    return `deployer farm ${dep.launchesPerDay.toFixed(1)}/day`;
  return null;
}

export function shadowCohortsFromPercentile(
  convictionPct: number | null | undefined,
  convWindowN?: number
) {
  if (
    convictionPct == null ||
    Number.isNaN(convictionPct) ||
    (convWindowN != null && convWindowN < MIN_PROMOTION_CONV_N)
  ) {
    return { ...EMPTY_COHORTS };
  }
  const p = convictionPct / 100;
  return {
    top5: p >= 0.95,
    top2: p >= 0.98,
    top1: p >= 0.99,
    top05: p >= 0.995,
    top01: p >= 0.999,
  };
}

export function shadowSizeForPercentile(convictionFrac: number): number {
  if (convictionFrac < 0.995) return 0;
  if (convictionFrac < 0.999) return 0.01;
  if (convictionFrac < 0.9995) return 0.015;
  return 0.025;
}

export function resolveBuySol(opts: {
  deployer: DeployerSignal;
  creator: CreatorSignal;
  baseUnits?: number;
  minAdmission?: number;
  liveBuySol?: number;
  liveConvictionGate?: boolean;
  /** Live gate threshold as percentile fraction; default top2%=0.98 once enabled */
  liveGateFrac?: number;
  wCreator?: number;
  wDeployer?: number;
}): SelectionDecision {
  const liveBuySol =
    opts.liveBuySol ?? Number(process.env.SNIPE_BUY_SOL || "0.025");
  const liveConvictionGate =
    opts.liveConvictionGate ??
    (process.env.SNIPE_LIVE_CONVICTION_GATE || "false") === "true";
  const liveGateFrac =
    opts.liveGateFrac ?? Number(process.env.SNIPE_LIVE_GATE_FRAC || "0.98");
  const minAdmission = opts.minAdmission ?? 0;

  const admissionScore = blendAdmission(
    opts.creator,
    opts.deployer,
    opts.wCreator,
    opts.wDeployer
  );
  // Always record global (structurally valid path calls this after farm check)
  noteGlobalScore(admissionScore);
  if (minAdmission <= 0 || admissionScore >= minAdmission) {
    noteEligibleScore(admissionScore);
  }

  const globalConvPct = percentileIn(recentGlobal, admissionScore);
  const eligibleConvPct = percentileIn(recentEligible, admissionScore);
  const convictionFrac =
    globalConvPct == null ? 0 : globalConvPct / 100;
  const globalConvN = recentGlobal.length;
  const eligibleConvN = recentEligible.length;
  // Promotion cohorts gated on window depth — tiny-n p100 is not top-0.5%
  const cohorts = shadowCohortsFromPercentile(globalConvPct, globalConvN);
  const eligibleShadowCohorts = shadowCohortsFromPercentile(
    eligibleConvPct,
    eligibleConvN
  );
  const shadowBuySol =
    globalConvPct == null || globalConvN < MIN_PROMOTION_CONV_N
      ? 0
      : shadowSizeForPercentile(convictionFrac);
  const core = extractCoreFeatures(opts.deployer);

  const structural = deployerStructuralReject(opts.deployer);
  if (structural) {
    return {
      admit: false,
      reason: structural,
      admissionScore,
      globalConvPct,
      eligibleConvPct,
      convictionPct: globalConvPct,
      convictionFrac,
      sizeMult: 0,
      buySol: 0,
      units: 0,
      shadowCohorts: cohorts,
      eligibleShadowCohorts,
      shadowBuySol,
      core,
      globalConvN,
      eligibleConvN,
    };
  }

  if (minAdmission > 0 && admissionScore < minAdmission) {
    return {
      admit: false,
      reason: `admission ${admissionScore} < ${minAdmission}`,
      admissionScore,
      globalConvPct,
      eligibleConvPct,
      convictionPct: globalConvPct,
      convictionFrac,
      sizeMult: 0,
      buySol: 0,
      units: 0,
      shadowCohorts: cohorts,
      eligibleShadowCohorts,
      shadowBuySol,
      core,
      globalConvN,
      eligibleConvN,
    };
  }

  if (
    liveConvictionGate &&
    globalConvPct != null &&
    convictionFrac < liveGateFrac
  ) {
    return {
      admit: false,
      reason: `conviction p${globalConvPct.toFixed(1)} < live gate ${(
        liveGateFrac * 100
      ).toFixed(1)}`,
      admissionScore,
      globalConvPct,
      eligibleConvPct,
      convictionPct: globalConvPct,
      convictionFrac,
      sizeMult: 0,
      buySol: 0,
      units: 0,
      shadowCohorts: cohorts,
      eligibleShadowCohorts,
      shadowBuySol,
      core,
      globalConvN,
      eligibleConvN,
    };
  }

  return {
    admit: true,
    admissionScore,
    globalConvPct,
    eligibleConvPct,
    convictionPct: globalConvPct,
    convictionFrac,
    sizeMult: 1,
    buySol: liveBuySol,
    units: liveBuySol / UNIT_SOL,
    shadowCohorts: cohorts,
    eligibleShadowCohorts,
    shadowBuySol,
    core,
    globalConvN,
    eligibleConvN,
  };
}

export function estimateEdge(opts: {
  creator: CreatorSignal;
  deployer: DeployerSignal;
  buySol: number;
  slotDelta?: number;
}): {
  pRunner: number;
  pAdverse: number;
  expectedPnl30: number;
  edgeSol: number;
} {
  const pRunner = Math.min(
    0.95,
    Math.max(
      0.02,
      (opts.deployer.positiveMfe30Rate ?? opts.creator.winRate ?? 0.12) * 0.7 +
        (opts.creator.winRate ?? 0.12) * 0.3
    )
  );
  const pAdverse = Math.min(
    0.95,
    Math.max(
      0.05,
      (opts.deployer.dumpRate ?? 0.35) * 0.7 + (opts.creator.dumpRate ?? 0.35) * 0.3
    )
  );
  const runnerPayoff = 0.2;
  const lossCost = 0.18;
  const feeDrag = 0.04;
  const lag = opts.slotDelta ?? 0;
  const lagPenalty = lag <= 0 ? 0 : lag === 1 ? 0.04 : 0.12;
  const expectedPnl30 =
    pRunner * runnerPayoff - pAdverse * lossCost - feeDrag - lagPenalty;
  return {
    pRunner,
    pAdverse,
    expectedPnl30,
    edgeSol: expectedPnl30 * opts.buySol,
  };
}

/**
 * Dual health kill switch:
 * 1) rolling avg executable PnL too negative
 * 2) model discrimination collapsed (top quartile runner rate <= bottom)
 */
export function expectancyKillSwitch(opts?: {
  minN?: number;
  maxAvgLossPct?: number;
}): string | null {
  const minN = opts?.minN ?? 12;
  const maxAvgLossPct = opts?.maxAvgLossPct ?? -15;
  const now = Date.now();
  const windows = [
    { label: "7d", ms: 7 * 86_400_000 },
    { label: "14d", ms: 14 * 86_400_000 },
    { label: "30d", ms: 30 * 86_400_000 },
  ];
  for (const w of windows) {
    const arr = recentExits.filter((e) => now - e.ts <= w.ms);
    if (arr.length < minN) continue;
    const avg = arr.reduce((a, b) => a + b.pnlPct, 0) / arr.length;
    if (avg < maxAvgLossPct) {
      return `kill ${w.label} avgExecPnl=${avg.toFixed(1)}% n=${arr.length}`;
    }
    // Discrimination health
    const byScore = [...arr].sort(
      (a, b) => a.admissionScore - b.admissionScore
    );
    const q = Math.max(1, Math.floor(byScore.length / 4));
    const bottom = byScore.slice(0, q);
    const top = byScore.slice(-q);
    const rate = (xs: ExitObs[]) =>
      xs.filter((x) => x.runner).length / Math.max(1, xs.length);
    const topR = rate(top);
    const botR = rate(bottom);
    if (topR <= botR) {
      return `kill ${w.label} discrimination topQ runner=${(
        topR * 100
      ).toFixed(0)}% <= botQ ${(botR * 100).toFixed(0)}% n=${arr.length}`;
    }
  }
  return null;
}

export function recentScoreCount(): number {
  return recentGlobal.length;
}

export function recentGlobalCount(): number {
  return recentGlobal.length;
}

export function recentEligibleCount(): number {
  return recentEligible.length;
}
