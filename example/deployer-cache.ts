/**
 * Deployer intelligence — primary selection signal.
 *
 * Evidence (zero-block sniper reverse-eng): deployer reputation/cadence/stake
 * dominate; metadata and fee features add little or hurt. Target ~top 0.5%.
 */
import fs from "fs";
import path from "path";
import {
  confidenceFromN,
  shrinkScore,
  PRIOR_QUALITY,
  PRIOR_WEIGHT,
} from "./creator-cache";

const CACHE_DIR = path.join(__dirname, "../../wallets");
const CACHE_PATH = path.join(CACHE_DIR, "deployer-cache.json");

export interface DeployerLaunchSample {
  mint: string;
  ts: number;
  bought: boolean;
  mfePct?: number;
  maePct?: number;
  pnlPct?: number;
  graduated?: boolean;
  dumped?: boolean;
  sameTxBuy?: boolean;
  initialBuySol?: number;
  name?: string;
  symbol?: string;
  uriHost?: string;
}

export interface DeployerStats {
  deployer: string;
  n: number;
  buys: number;
  skips: number;
  wins: number;
  dumps: number;
  graduated: number;
  sumMfe: number;
  sumMae: number;
  sumPnl: number;
  outcomes: number;
  sameTxBuys: number;
  sumInitialBuySol: number;
  initialBuySamples: number;
  /** Running mean of prior launch stakes (updated on each note) */
  prevDevBuyMean: number;
  nameCounts: Record<string, number>;
  symbolCounts: Record<string, number>;
  uriHostCounts: Record<string, number>;
  lastLaunchTs: number;
  lastMint?: string;
  fundingCluster?: string;
  samples: DeployerLaunchSample[];
}

export interface DeployerScoreContext {
  currentDevBuySol?: number;
  now?: number;
  /** Current mint — ignore self when computing secs-since-prior */
  mint?: string;
}

export interface DeployerSignal {
  deployer: string;
  quality: number;
  confidence: number;
  observations: number;
  /** Shrunk 0..100 used by admission */
  score: number;
  launches5m: number;
  launches1h: number;
  launches24h: number;
  launches7d: number;
  /** Approximate launches/day from 7d window */
  launchesPerDay: number;
  secsSincePriorLaunch: number | null;
  medianInterLaunchSeconds: number | null;
  prevDevBuyMean: number | null;
  currentDevBuySol: number | null;
  boughtDeployerBefore: boolean;
  positiveMfe30Rate: number | null;
  medianMfe30: number | null;
  dumpRate: number | null;
  sameTxBuyRate: number | null;
  medianInitialBuySol: number | null;
  repeatedNameRate: number;
  repeatedSymbolRate: number;
  repeatedUriHostRate: number;
  /** Interpretable branch tags */
  branch: "known_good" | "cold_viable" | "spam" | "weak" | "unknown";
  reasons: string[];
  unknown: boolean;
}

const MAX_SAMPLES = 80;
/** Research: cold viable if wait ≳92min and stake >0.555 SOL */
export const COLD_MIN_WAIT_SEC = 92 * 60;
export const COLD_MIN_DEV_BUY = 0.555;
/** Bought cohort median ~1.85/day; ignored ~9.89 — reject above this */
export const MAX_LAUNCHES_PER_DAY = 5;
/** Soft floor for known deployers (ignored cohort was 88–104s) */
export const MIN_SECS_SINCE_PRIOR_KNOWN = 300;

let byDeployer = new Map<string, DeployerStats>();
let dirty = false;
let loaded = false;

function empty(deployer: string): DeployerStats {
  return {
    deployer,
    n: 0,
    buys: 0,
    skips: 0,
    wins: 0,
    dumps: 0,
    graduated: 0,
    sumMfe: 0,
    sumMae: 0,
    sumPnl: 0,
    outcomes: 0,
    sameTxBuys: 0,
    sumInitialBuySol: 0,
    initialBuySamples: 0,
    prevDevBuyMean: 0,
    nameCounts: {},
    symbolCounts: {},
    uriHostCounts: {},
    lastLaunchTs: 0,
    samples: [],
  };
}

function bumpCount(map: Record<string, number>, key?: string) {
  if (!key) return;
  const k = key.slice(0, 64);
  map[k] = (map[k] || 0) + 1;
}

function uriHost(uri?: string): string | undefined {
  if (!uri) return undefined;
  try {
    return new URL(uri).host || undefined;
  } catch {
    return uri.slice(0, 48);
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function repeatRate(counts: Record<string, number>, total: number): number {
  if (total <= 1) return 0;
  let repeats = 0;
  for (const c of Object.values(counts)) {
    if (c >= 2) repeats += c;
  }
  return repeats / total;
}

export function loadDeployerCache(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const rows: DeployerStats[] = Array.isArray(raw)
      ? raw
      : Object.values(raw?.deployers || {});
    byDeployer = new Map();
    for (const r of rows) {
      if (!r?.deployer) continue;
      if (r.prevDevBuyMean == null) {
        r.prevDevBuyMean =
          r.initialBuySamples > 0
            ? r.sumInitialBuySol / r.initialBuySamples
            : 0;
      }
      byDeployer.set(r.deployer, r);
    }
    console.log(`[deployer-cache] loaded ${byDeployer.size} deployers`);
  } catch (e) {
    console.warn("[deployer-cache] load fail", (e as Error).message);
  }
}

export function saveDeployerCache(force = false): void {
  if (!dirty && !force) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify(
        { updatedAt: Date.now(), deployers: [...byDeployer.values()] },
        null,
        0
      )
    );
    dirty = false;
  } catch (e) {
    console.warn("[deployer-cache] save fail", (e as Error).message);
  }
}

export function getDeployer(deployer: string): DeployerStats | undefined {
  loadDeployerCache();
  return byDeployer.get(deployer);
}

export function noteDeployerLaunch(
  deployer: string,
  mint: string,
  bought: boolean,
  extra?: {
    sameTxBuy?: boolean;
    initialBuySol?: number;
    name?: string;
    symbol?: string;
    uri?: string;
  }
): void {
  if (!deployer) return;
  loadDeployerCache();
  let r = byDeployer.get(deployer);
  if (!r) {
    r = empty(deployer);
    byDeployer.set(deployer, r);
  }
  // Update prior-mean BEFORE counting this launch's stake into the mean used next time
  if (typeof extra?.initialBuySol === "number" && extra.initialBuySol > 0) {
    const n = r.initialBuySamples;
    r.prevDevBuyMean =
      n > 0
        ? (r.prevDevBuyMean * n + extra.initialBuySol) / (n + 1)
        : extra.initialBuySol;
    r.sumInitialBuySol += extra.initialBuySol;
    r.initialBuySamples += 1;
  }
  r.n += 1;
  if (bought) r.buys += 1;
  else r.skips += 1;
  r.lastLaunchTs = Date.now();
  r.lastMint = mint;
  if (extra?.sameTxBuy) r.sameTxBuys += 1;
  bumpCount(r.nameCounts, extra?.name?.toLowerCase());
  bumpCount(r.symbolCounts, extra?.symbol?.toUpperCase());
  bumpCount(r.uriHostCounts, uriHost(extra?.uri));
  dirty = true;
}

export function noteDeployerOutcome(
  deployer: string,
  sample: DeployerLaunchSample
): void {
  if (!deployer) return;
  loadDeployerCache();
  let r = byDeployer.get(deployer);
  if (!r) {
    r = empty(deployer);
    byDeployer.set(deployer, r);
  }
  const dumped =
    sample.dumped === true ||
    (typeof sample.maePct === "number" &&
      sample.maePct <= -25 &&
      (sample.mfePct ?? 0) < 10);
  const win =
    (typeof sample.mfePct === "number" && sample.mfePct >= 30) ||
    (typeof sample.pnlPct === "number" && sample.pnlPct > 0);

  r.outcomes += 1;
  if (typeof sample.mfePct === "number") r.sumMfe += sample.mfePct;
  if (typeof sample.maePct === "number") r.sumMae += sample.maePct;
  if (typeof sample.pnlPct === "number") r.sumPnl += sample.pnlPct;
  if (win) r.wins += 1;
  if (dumped) r.dumps += 1;
  if (sample.graduated) r.graduated += 1;

  r.samples.push({ ...sample, dumped });
  if (r.samples.length > MAX_SAMPLES) r.samples.shift();
  dirty = true;
}

function countRecent(r: DeployerStats, windowMs: number, now: number): number {
  return r.samples.filter((s) => now - s.ts < windowMs).length;
}

/**
 * Hot-path deployer score. Context supplies current same-tx buy stake.
 */
export function scoreDeployer(
  deployer: string,
  ctx?: DeployerScoreContext
): DeployerSignal {
  loadDeployerCache();
  const now = ctx?.now ?? Date.now();
  const currentDevBuySol =
    typeof ctx?.currentDevBuySol === "number" ? ctx.currentDevBuySol : null;
  const r = byDeployer.get(deployer);

  const launches5m = r ? countRecent(r, 5 * 60_000, now) : 0;
  const launches1h = r ? countRecent(r, 3_600_000, now) : 0;
  const launches24h = r ? countRecent(r, 86_400_000, now) : 0;
  const launches7d = r ? countRecent(r, 7 * 86_400_000, now) : 0;
  // Include current launch in cadence
  const launchesPerDay = (launches7d + 1) / 7;
  let secsSincePriorLaunch: number | null = null;
  if (r && r.lastLaunchTs > 0) {
    if (ctx?.mint && r.lastMint === ctx.mint) {
      // Same mint already noted — use previous sample timestamp if any
      const prior = [...r.samples].reverse().find((s) => s.mint !== ctx.mint);
      secsSincePriorLaunch = prior
        ? Math.max(0, (now - prior.ts) / 1000)
        : null;
    } else {
      secsSincePriorLaunch = Math.max(0, (now - r.lastLaunchTs) / 1000);
    }
  }
  const medianInterLaunchSeconds = (() => {
    if (!r || r.samples.length < 2) return null;
    const ts = r.samples.map((s) => s.ts).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
    return median(gaps);
  })();
  const boughtDeployerBefore = !!(r && r.buys > 0);
  const prevDevBuyMean =
    r && r.initialBuySamples > 0 ? r.prevDevBuyMean : null;

  const baseUnknown = (): DeployerSignal => {
    const reasons: string[] = ["unknown-deployer"];
    let quality = 35;
    let branch: DeployerSignal["branch"] = "unknown";

    if (launchesPerDay >= MAX_LAUNCHES_PER_DAY || launches1h >= 8) {
      quality = 5;
      branch = "spam";
      reasons.push("spam-cadence");
    } else if (
      secsSincePriorLaunch != null &&
      secsSincePriorLaunch >= COLD_MIN_WAIT_SEC &&
      (currentDevBuySol ?? 0) >= COLD_MIN_DEV_BUY
    ) {
      // Research cold-viable branch: waited 92+ min + stake >0.555
      quality = 68;
      branch = "cold_viable";
      reasons.push("cold-viable-wait+stake");
    } else if ((currentDevBuySol ?? 0) >= 3.0 && (secsSincePriorLaunch ?? 0) > 600) {
      quality = 58;
      branch = "cold_viable";
      reasons.push("cold-large-stake");
    } else if ((currentDevBuySol ?? 0) > 0 && (currentDevBuySol ?? 0) < 0.25) {
      quality = 25;
      branch = "weak";
      reasons.push("tiny-dev-buy");
    } else {
      reasons.push("cold-no-signal");
    }

    const observations = 0;
    const score = Math.round(
      Math.max(0, Math.min(100, shrinkScore(quality, observations)))
    );
    return {
      deployer,
      quality,
      confidence: 0,
      observations,
      score,
      launches5m,
      launches1h,
      launches24h,
      launches7d,
      launchesPerDay,
      secsSincePriorLaunch,
      medianInterLaunchSeconds,
      prevDevBuyMean,
      currentDevBuySol,
      boughtDeployerBefore: false,
      positiveMfe30Rate: null,
      medianMfe30: null,
      dumpRate: null,
      sameTxBuyRate: null,
      medianInitialBuySol: null,
      repeatedNameRate: 0,
      repeatedSymbolRate: 0,
      repeatedUriHostRate: 0,
      branch,
      reasons,
      unknown: true,
    };
  };

  if (!r || r.outcomes < 1) {
    // Still use launch cadence even without outcomes
    if (!r) return baseUnknown();
    // Have launches but no outcomes yet — treat as semi-cold with cadence
    const sig = baseUnknown();
    sig.observations = 0;
    sig.boughtDeployerBefore = boughtDeployerBefore;
    if (boughtDeployerBefore) {
      sig.quality = Math.min(100, sig.quality + 8);
      sig.reasons.push("bought-before-no-outcome");
      sig.score = Math.round(shrinkScore(sig.quality, 1));
    }
    if (launchesPerDay >= MAX_LAUNCHES_PER_DAY) {
      sig.branch = "spam";
      sig.score = Math.min(sig.score, 15);
    }
    return sig;
  }

  const winRate = r.wins / Math.max(1, r.outcomes);
  const dumpRate = r.dumps / Math.max(1, r.outcomes);
  const avgMfe = r.sumMfe / Math.max(1, r.outcomes);
  const mfeSamples = r.samples
    .map((s) => s.mfePct)
    .filter((x): x is number => typeof x === "number");
  const positiveMfe30Rate =
    mfeSamples.length > 0
      ? mfeSamples.filter((x) => x >= 30).length / mfeSamples.length
      : null;
  const reasons: string[] = [];
  let branch: DeployerSignal["branch"] = "weak";

  // Reputation core
  let quality = 15 + winRate * 55 - dumpRate * 40;
  if (avgMfe >= 40) {
    quality += 10;
    reasons.push("avgMfe>=40");
  } else if (avgMfe >= 25) {
    quality += 5;
    reasons.push("avgMfe>=25");
  }
  if (boughtDeployerBefore && winRate >= 0.4 && dumpRate < 0.4) {
    quality += 18;
    reasons.push("known-good-bought-before");
    branch = "known_good";
  } else if (boughtDeployerBefore) {
    quality += 6;
    reasons.push("bought-before");
  }

  // Cadence — strongest negative in research
  if (launchesPerDay >= MAX_LAUNCHES_PER_DAY || launches1h >= 8) {
    quality -= 35;
    branch = "spam";
    reasons.push("spam-cadence");
  } else if (launches1h >= 4) {
    quality -= 18;
    reasons.push("busy-1h");
  } else if (launchesPerDay <= 2.5) {
    quality += 8;
    reasons.push("low-cadence");
  }

  // Time since prior launch (bought ~6ks, ignored ~90s)
  if (secsSincePriorLaunch != null) {
    if (secsSincePriorLaunch < 120) {
      quality -= 25;
      reasons.push("rapid-relaunch");
      if (branch !== "known_good") branch = "spam";
    } else if (secsSincePriorLaunch >= COLD_MIN_WAIT_SEC) {
      quality += 10;
      reasons.push("long-wait");
    } else if (secsSincePriorLaunch >= 1800) {
      quality += 4;
      reasons.push("medium-wait");
    }
  }

  // Stake economics — contextual, not universal small-buy
  const stake = currentDevBuySol ?? 0;
  if (stake >= 3.0) {
    quality += 12;
    reasons.push("dev-stake>=3");
  } else if (stake >= 1.0) {
    quality += 7;
    reasons.push("dev-stake>=1");
  } else if (stake >= COLD_MIN_DEV_BUY) {
    quality += 3;
    reasons.push("dev-stake>=0.55");
  } else if (stake > 0 && stake < 0.25) {
    quality -= 8;
    reasons.push("tiny-dev-buy");
  }
  if (prevDevBuyMean != null && prevDevBuyMean >= 2.5 && stake >= 1.0) {
    quality += 5;
    reasons.push("hist-stake-consistent");
  }

  const repeatedNameRate = repeatRate(r.nameCounts, r.n);
  const repeatedSymbolRate = repeatRate(r.symbolCounts, r.n);
  const repeatedUriHostRate = repeatRate(r.uriHostCounts, r.n);
  if (repeatedNameRate >= 0.4 || repeatedSymbolRate >= 0.4) {
    quality -= 12;
    reasons.push("name/symbol-reuse");
  }
  if (repeatedUriHostRate >= 0.5) {
    quality -= 8;
    reasons.push("uri-host-reuse");
  }

  if (branch === "weak" && quality >= 65) branch = "known_good";
  if (
    branch === "weak" &&
    secsSincePriorLaunch != null &&
    secsSincePriorLaunch >= COLD_MIN_WAIT_SEC &&
    stake >= COLD_MIN_DEV_BUY
  ) {
    branch = "cold_viable";
  }

  quality = Math.max(0, Math.min(100, quality));
  const observations = r.outcomes;
  const score = Math.round(
    Math.max(0, Math.min(100, shrinkScore(quality, observations)))
  );
  reasons.push(`raw=${quality.toFixed(0)} n=${observations} eff=${score}`);

  const buySols = r.samples
    .map((s) => s.initialBuySol)
    .filter((x): x is number => typeof x === "number");

  return {
    deployer,
    quality: Math.round(quality),
    confidence: confidenceFromN(observations),
    observations,
    score,
    launches5m,
    launches1h,
    launches24h,
    launches7d,
    launchesPerDay,
    secsSincePriorLaunch,
    medianInterLaunchSeconds,
    prevDevBuyMean,
    currentDevBuySol,
    boughtDeployerBefore,
    positiveMfe30Rate,
    medianMfe30: median(mfeSamples),
    dumpRate,
    sameTxBuyRate: r.n > 0 ? r.sameTxBuys / r.n : null,
    medianInitialBuySol:
      buySols.length > 0
        ? median(buySols)
        : r.initialBuySamples > 0
          ? r.sumInitialBuySol / r.initialBuySamples
          : null,
    repeatedNameRate,
    repeatedSymbolRate,
    repeatedUriHostRate,
    branch,
    reasons,
    unknown: false,
  };
}

export function startDeployerCacheFlusher(intervalMs = 30_000): void {
  loadDeployerCache();
  setInterval(() => saveDeployerCache(), intervalMs).unref?.();
  process.on("exit", () => saveDeployerCache(true));
  process.on("SIGINT", () => {
    saveDeployerCache(true);
  });
}

export { CACHE_PATH, PRIOR_QUALITY, PRIOR_WEIGHT };
