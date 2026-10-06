/**
 * Creator intelligence cache — precomputed before create, O(1) hot-path lookup.
 *
 * Score = Bayesian-shrunk quality. Sparse creators are pulled toward prior so
 * one lucky launch cannot look like a 30-sample veteran.
 */
import fs from "fs";
import path from "path";

const CACHE_DIR = path.join(__dirname, "../../wallets");
const CACHE_PATH = path.join(CACHE_DIR, "creator-cache.json");

export interface CreatorLaunchSample {
  mint: string;
  ts: number;
  bought: boolean;
  mfePct?: number;
  maePct?: number;
  pnlPct?: number;
  graduated?: boolean;
  dumped?: boolean;
}

export interface CreatorRecord {
  creator: string;
  launches: number;
  buys: number;
  skips: number;
  wins: number;
  dumps: number;
  graduated: number;
  sumMfe: number;
  sumMae: number;
  sumPnl: number;
  outcomes: number;
  lastLaunchTs: number;
  lastMint?: string;
  lastCreatorSol?: number;
  fundedBy?: string[];
  linkedCreators?: string[];
  samples: CreatorLaunchSample[];
}

/** Hot-path signal used by admission */
export interface CreatorSignal {
  creator: string;
  /** Raw quality 0..100 before shrinkage */
  quality: number;
  /** 0..1 confidence from observation count */
  confidence: number;
  observations: number;
  /** Shrunk score used by admission (0..100) */
  score: number;
  launches: number;
  winRate: number | null;
  dumpRate: number | null;
  avgMfe: number | null;
  reasons: string[];
  unknown: boolean;
}

/** @deprecated alias — scoreCreator returns CreatorSignal */
export type CreatorScore = CreatorSignal;

const MAX_SAMPLES = 40;
const PRIOR_QUALITY = 50;
const PRIOR_WEIGHT = 8;

let byCreator = new Map<string, CreatorRecord>();
let dirty = false;
let loaded = false;

function empty(creator: string): CreatorRecord {
  return {
    creator,
    launches: 0,
    buys: 0,
    skips: 0,
    wins: 0,
    dumps: 0,
    graduated: 0,
    sumMfe: 0,
    sumMae: 0,
    sumPnl: 0,
    outcomes: 0,
    lastLaunchTs: 0,
    samples: [],
  };
}

/** Empirical Bayes shrink toward prior */
export function shrinkScore(
  rawQuality: number,
  observations: number,
  prior = PRIOR_QUALITY,
  priorWeight = PRIOR_WEIGHT
): number {
  const n = Math.max(0, observations);
  return (rawQuality * n + prior * priorWeight) / (n + priorWeight);
}

export function confidenceFromN(observations: number, priorWeight = PRIOR_WEIGHT): number {
  const n = Math.max(0, observations);
  return n / (n + priorWeight);
}

export function loadCreatorCache(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const rows: CreatorRecord[] = Array.isArray(raw)
      ? raw
      : Object.values(raw?.creators || {});
    byCreator = new Map();
    for (const r of rows) {
      if (r?.creator) byCreator.set(r.creator, r);
    }
    console.log(`[creator-cache] loaded ${byCreator.size} creators`);
  } catch (e) {
    console.warn("[creator-cache] load fail", (e as Error).message);
  }
}

export function saveCreatorCache(force = false): void {
  if (!dirty && !force) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const creators = [...byCreator.values()];
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ updatedAt: Date.now(), creators }, null, 0)
    );
    dirty = false;
  } catch (e) {
    console.warn("[creator-cache] save fail", (e as Error).message);
  }
}

export function getCreator(creator: string): CreatorRecord | undefined {
  loadCreatorCache();
  return byCreator.get(creator);
}

export function noteCreatorLaunch(
  creator: string,
  mint: string,
  bought: boolean,
  creatorSol?: number
): void {
  loadCreatorCache();
  let r = byCreator.get(creator);
  if (!r) {
    r = empty(creator);
    byCreator.set(creator, r);
  }
  r.launches += 1;
  if (bought) r.buys += 1;
  else r.skips += 1;
  r.lastLaunchTs = Date.now();
  r.lastMint = mint;
  if (creatorSol != null) r.lastCreatorSol = creatorSol;
  dirty = true;
}

export function noteCreatorOutcome(
  creator: string,
  sample: CreatorLaunchSample
): void {
  loadCreatorCache();
  let r = byCreator.get(creator);
  if (!r) {
    r = empty(creator);
    byCreator.set(creator, r);
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

function rawQualityFromRecord(
  r: CreatorRecord,
  opts?: { creatorSol?: number }
): { quality: number; reasons: string[] } {
  const reasons: string[] = [];
  const winRate = r.wins / Math.max(1, r.outcomes);
  const dumpRate = r.dumps / Math.max(1, r.outcomes);
  const avgMfe = r.sumMfe / Math.max(1, r.outcomes);

  let quality = 20 + winRate * 60;
  quality -= dumpRate * 35;
  if (avgMfe >= 40) {
    quality += 8;
    reasons.push("avgMfe>=40");
  } else if (avgMfe >= 25) {
    quality += 4;
    reasons.push("avgMfe>=25");
  }
  if (opts?.creatorSol != null && opts.creatorSol < 0.15) {
    quality -= 10;
    reasons.push("thin-sol");
  }
  const recent = r.samples.filter((s) => Date.now() - s.ts < 3_600_000).length;
  if (recent >= 8) {
    quality -= 15;
    reasons.push("burst-launches");
  }
  reasons.push(
    `win=${(winRate * 100).toFixed(0)}% dump=${(dumpRate * 100).toFixed(0)}%`
  );
  return {
    quality: Math.max(0, Math.min(100, quality)),
    reasons,
  };
}

/**
 * Hot-path score. Returns shrunk `score` for admission + raw quality/confidence.
 */
export function scoreCreator(
  creator: string,
  opts?: { creatorSol?: number }
): CreatorSignal {
  loadCreatorCache();
  const r = byCreator.get(creator);

  if (!r || r.outcomes < 1) {
    let quality = 45;
    const reasons: string[] = [];
    if (opts?.creatorSol != null) {
      if (opts.creatorSol >= 1) {
        quality = 55;
        reasons.push("cold+sol>=1");
      } else if (opts.creatorSol < 0.2) {
        quality = 30;
        reasons.push("cold+thin-sol");
      } else reasons.push("cold");
    } else reasons.push("unknown");
    const observations = 0;
    const score = Math.round(shrinkScore(quality, observations));
    return {
      creator,
      quality,
      confidence: confidenceFromN(observations),
      observations,
      score,
      launches: r?.launches ?? 0,
      winRate: null,
      dumpRate: null,
      avgMfe: null,
      reasons,
      unknown: true,
    };
  }

  const { quality, reasons } = rawQualityFromRecord(r, opts);
  const observations = r.outcomes;
  const score = Math.round(
    Math.max(0, Math.min(100, shrinkScore(quality, observations)))
  );
  reasons.push(`raw=${quality.toFixed(0)} n=${observations} eff=${score}`);

  return {
    creator,
    quality: Math.round(quality),
    confidence: confidenceFromN(observations),
    observations,
    score,
    launches: r.launches,
    winRate: r.wins / Math.max(1, r.outcomes),
    dumpRate: r.dumps / Math.max(1, r.outcomes),
    avgMfe: r.sumMfe / Math.max(1, r.outcomes),
    reasons,
    unknown: false,
  };
}

export function startCreatorCacheFlusher(intervalMs = 30_000): void {
  loadCreatorCache();
  setInterval(() => saveCreatorCache(), intervalMs).unref?.();
  process.on("exit", () => saveCreatorCache(true));
  process.on("SIGINT", () => {
    saveCreatorCache(true);
  });
}

export { CACHE_PATH, PRIOR_QUALITY, PRIOR_WEIGHT };
