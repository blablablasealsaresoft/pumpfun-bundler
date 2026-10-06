/**
 * Shadow-only selection model v2.
 * Does not submit trades, size orders, or set a live PASS.
 *
 * Frozen baseline (do not retune after seeing this sample):
 *   deployer85-shrink-v1 shrinks raw quality toward prior 50 with weight 8.
 *   observations = 0 ⇒ score is exactly 50 for every raw quality.
 * That prior is uncertainty, not a data-backed score of 50.
 */
"use strict";

const { mean, pctile, spearman, kendallTau, mulberry32, bootstrapMedianDiff } = require("./math");

const OLD_MODEL = "deployer85-shrink-v1";
const NEW_MODEL = "selection-v2-shadow";
const NEW_EPOCH = "selection_v2_shadow_2026_10";
const FEATURE_VERSION = "selection-v2-decision-time-1";
const PRIOR_QUALITY = 50;
const PRIOR_WEIGHT = 8;
const RESEARCH_RHO_MIN = 0.15;
const COLLAPSE_FLAG_PCT = 0.4;
const COLLAPSE_BLOCK_PCT = 0.8;
const MAE_SLACK_PP = 5;
const REGIME_COLD_LT = 8;
const REGIME_HOT_GE = 25;
const OUTCOME_KNOWABLE_AFTER_MS = 30_000;
const REGIME_OUTCOME_WINDOW_MS = 10 * 60_000;

/** Predeclared recency half-lives. Not chosen by maximizing in-sample rho. */
const RECENCY_VARIANTS = [
  { name: "lifetime", halfLifeMs: Infinity },
  { name: "30d", halfLifeMs: 30 * 86_400_000 },
  { name: "7d", halfLifeMs: 7 * 86_400_000 },
  { name: "24h", halfLifeMs: 86_400_000 },
  { name: "last5", lastN: 5 },
];

const CREATOR_SOL_BUCKETS = [
  "<0.05",
  "0.05-0.10",
  "0.10-0.25",
  "0.25-0.50",
  "0.50-1",
  "1-5",
  ">5",
];

/** Considered, but absent from decision traces. Never fabricated. */
const UNAVAILABLE_FEATURES = [
  "uniqueEarlyBuyers",
  "buyerConcentration",
  "repeatBuyerConcentration",
  "knownWalletParticipation",
  "relatedWalletBuys",
  "buyCountGrowthFirstNms",
  "buySolGrowth",
  "uniqueWalletGrowth",
  "netBuyFlow",
  "sellAppearance",
  "earlyDistributionConcentration",
  "topWalletShare",
  "walletNovelty",
  "socialConfirmation",
  "deployerPriorOutcomeSeries",
];

const FORBIDDEN_LIVE_TEXT = /ENABLE LIVE|PROMOTE LIVE|TURN OFF KILL/;

function shrinkScore(rawQuality, observations, prior = PRIOR_QUALITY, priorWeight = PRIOR_WEIGHT) {
  const n = Math.max(0, observations);
  return (rawQuality * n + prior * priorWeight) / (n + priorWeight);
}

function confidenceFromN(observations, priorWeight = PRIOR_WEIGHT) {
  const n = Math.max(0, Number(observations) || 0);
  return n / (n + priorWeight);
}

function isDataBacked(scored) {
  return !!(
    scored &&
    scored.source !== "prior" &&
    typeof scored.evidenceN === "number" &&
    scored.evidenceN >= 1 &&
    typeof scored.expectedQuality === "number" &&
    typeof scored.confidence === "number" &&
    scored.confidence > 0
  );
}

function abstain(evidenceN = 0) {
  return {
    expectedQuality: null,
    confidence: 0,
    evidenceN: Math.max(0, evidenceN || 0),
    source: "prior",
    rankScore: null,
    executionImpact: "none",
    maySubmit: false,
    components: {
      deployer: null,
      walletFlow: null,
      launchStructure: null,
      socialConfirmation: null,
      liquidityStructure: null,
      executionRisk: null,
    },
  };
}

/**
 * Model B — same conceptual deployer quality, without treating prior=50 as conviction.
 * Unknown history abstains (rankScore null). Known history ranks on unrounded raw quality.
 */
function modelB(row) {
  const n = typeof row.deployerN === "number" ? row.deployerN : 0;
  const raw = typeof row.rawScore === "number" && Number.isFinite(row.rawScore) ? row.rawScore : null;
  if (n < 1 || raw == null) return abstain(n);
  const expectedQuality = raw;
  return {
    expectedQuality,
    confidence: confidenceFromN(n),
    evidenceN: n,
    source: "deployer_history",
    rankScore: expectedQuality,
    executionImpact: "none",
    maySubmit: false,
    components: {
      deployer: expectedQuality,
      walletFlow: null,
      launchStructure: null,
      socialConfirmation: null,
      liquidityStructure: typeof row.creatorSol === "number" ? row.creatorSol : null,
      executionRisk: null,
    },
  };
}

/**
 * Model C — predeclared selection-v2-shadow.
 * Weights were fixed before the held-out read:
 *   known raw deployer quality
 *   −15 if launches in the last hour >= 8, else −6 if >= 4
 *   wallet proxy: (creatorBuySol − 1) * 5, clipped, plus −5 when the creator bought in the create tx
 *   execution proxy: −8 when numSigners >= 4
 * Wallet and execution terms are scaled by 0.25 so deployer quality remains the base.
 * Unknown deployers still abstain. creator SOL is recorded, not mixed into the rank.
 */
function modelC(row) {
  const base = modelB(row);
  if (base.rankScore == null) return base;
  let deployer = base.expectedQuality;
  if (typeof row.launches1h === "number") {
    if (row.launches1h >= 8) deployer -= 15;
    else if (row.launches1h >= 4) deployer -= 6;
  }
  let wallet = null;
  if (typeof row.creatorBuySol === "number" && Number.isFinite(row.creatorBuySol)) {
    wallet = Math.max(-20, Math.min(20, (row.creatorBuySol - 1) * 5));
  }
  if (row.sameTxCreatorBuy === true) wallet = (wallet || 0) - 5;
  let executionRisk = null;
  if (typeof row.numSigners === "number" && row.numSigners >= 4) executionRisk = -8;
  const launch = classifyLaunch(row);
  return {
    expectedQuality: deployer,
    confidence: base.confidence,
    evidenceN: base.evidenceN,
    source: "deployer_history",
    rankScore: deployer + (wallet || 0) * 0.25 + (executionRisk || 0) * 0.25,
    executionImpact: "none",
    maySubmit: false,
    components: {
      deployer,
      walletFlow: wallet,
      launchStructure: launch.quoteAssetClass === "unknown" ? null : launch.quoteAssetClass,
      socialConfirmation: null,
      liquidityStructure: typeof row.creatorSol === "number" ? row.creatorSol : null,
      executionRisk,
    },
  };
}

const LINEAR_FEATURES = [
  {
    name: "rawScore",
    get: (r) => (r.deployerN >= 1 && typeof r.rawScore === "number" ? r.rawScore : null),
  },
  {
    name: "logDeployerN",
    get: (r) => (typeof r.deployerN === "number" ? Math.log1p(Math.max(0, r.deployerN)) : null),
  },
  {
    name: "logCreatorSol",
    get: (r) => (typeof r.creatorSol === "number" ? Math.log1p(Math.max(0, r.creatorSol)) : null),
  },
  {
    name: "creatorBuySol",
    get: (r) => (typeof r.creatorBuySol === "number" ? r.creatorBuySol : null),
  },
  {
    name: "sameTxCreatorBuy",
    get: (r) => (r.sameTxCreatorBuy === true ? 1 : r.sameTxCreatorBuy === false ? 0 : null),
  },
  {
    name: "launches1h",
    get: (r) => (typeof r.launches1h === "number" ? r.launches1h : null),
  },
  {
    name: "logSecsSincePrior",
    get: (r) =>
      typeof r.secsSincePriorLaunch === "number" && r.secsSincePriorLaunch >= 0
        ? Math.log1p(r.secsSincePriorLaunch)
        : null,
  },
  {
    name: "previouslyProfitable",
    get: (r) =>
      typeof r.deployerPreviouslyProfitable === "number" ? r.deployerPreviouslyProfitable : null,
  },
  {
    name: "createsPrior60s",
    get: (r) => (typeof r.createsPrior60s === "number" ? r.createsPrior60s : null),
  },
  {
    name: "priorRunner10Rate",
    get: (r) => (typeof r.priorRunner10Rate === "number" ? r.priorRunner10Rate : null),
  },
  {
    name: "numSigners",
    get: (r) => (typeof r.numSigners === "number" ? r.numSigners : null),
  },
  {
    name: "holderReward",
    get: (r) => (r.holderReward === true ? 1 : r.holderReward === false ? 0 : null),
  },
];

/**
 * Model D — correlation-weighted linear rank.
 * Coefficients are Spearman(feature, pnl) on the training slice only.
 */
function fitLinearRank(trainRows) {
  const weights = {};
  const stats = {};
  for (const f of LINEAR_FEATURES) {
    const xs = [];
    const ys = [];
    for (const r of trainRows) {
      const x = f.get(r);
      if (typeof x !== "number" || !Number.isFinite(x) || typeof r.pnl !== "number") continue;
      xs.push(x);
      ys.push(r.pnl);
    }
    const rho = spearman(xs, ys).rho;
    const mu = mean(xs);
    let variance = 0;
    if (mu != null) {
      for (const x of xs) variance += (x - mu) * (x - mu);
      variance = xs.length ? variance / xs.length : 0;
    }
    weights[f.name] = rho == null ? 0 : rho;
    stats[f.name] = {
      mean: mu,
      std: Math.sqrt(variance),
      rho,
      n: xs.length,
    };
  }

  function score(row) {
    let s = 0;
    let used = 0;
    for (const f of LINEAR_FEATURES) {
      const w = weights[f.name];
      if (!w) continue;
      const x = f.get(row);
      if (typeof x !== "number" || !Number.isFinite(x)) continue;
      const st = stats[f.name];
      const z = st.std > 1e-9 && st.mean != null ? (x - st.mean) / st.std : 0;
      s += w * z;
      used++;
    }
    const n = typeof row.deployerN === "number" ? row.deployerN : 0;
    if (!used) return abstain(n);
    return {
      expectedQuality: n >= 1 && typeof row.rawScore === "number" ? row.rawScore : null,
      confidence: confidenceFromN(n),
      evidenceN: n,
      source: n >= 1 ? "linear_train_spearman" : "features_without_deployer_history",
      rankScore: s,
      executionImpact: "none",
      maySubmit: false,
      components: {
        deployer: n >= 1 ? row.rawScore : null,
        walletFlow: typeof row.creatorBuySol === "number" ? row.creatorBuySol : null,
        launchStructure: null,
        socialConfirmation: null,
        liquidityStructure: typeof row.creatorSol === "number" ? row.creatorSol : null,
        executionRisk: typeof row.numSigners === "number" ? row.numSigners : null,
      },
    };
  }

  return { weights, stats, score };
}

function classifyLaunch(row) {
  if (row && (row.isCustomPair === true || row.quoteAssetClass === "custom_pair")) {
    return {
      quoteAsset: row.quoteAsset || "custom",
      quoteAssetClass: "custom_pair",
      isCustomPair: true,
      launchProgramVariant: row.launchProgramVariant || "custom_pair",
    };
  }
  if (row && row.mayhem === true) {
    return {
      quoteAsset: "SOL",
      quoteAssetClass: "mayhem",
      isCustomPair: false,
      launchProgramVariant: "mayhem",
    };
  }
  if (row && row.buyFamily === "SOL_EXACT") {
    return {
      quoteAsset: "SOL",
      quoteAssetClass: "standard_sol",
      isCustomPair: false,
      launchProgramVariant: "sol_exact",
    };
  }
  if (row && row.buyFamily === "TOKEN_EXACT") {
    return {
      quoteAsset: row.quoteAsset || "unspecified_token",
      quoteAssetClass: "token_exact",
      isCustomPair: false,
      launchProgramVariant: "token_exact",
    };
  }
  return {
    quoteAsset: "unknown",
    quoteAssetClass: "unknown",
    isCustomPair: false,
    launchProgramVariant: "unspecified",
  };
}

function classifyRegime(createsPrior60s) {
  if (typeof createsPrior60s !== "number" || !Number.isFinite(createsPrior60s)) return "unknown";
  if (createsPrior60s >= REGIME_HOT_GE) return "hot";
  if (createsPrior60s < REGIME_COLD_LT) return "cold";
  return "normal";
}

function creatorSolBucket(sol) {
  if (typeof sol !== "number" || !Number.isFinite(sol)) return null;
  if (sol < 0.05) return "<0.05";
  if (sol < 0.1) return "0.05-0.10";
  if (sol < 0.25) return "0.10-0.25";
  if (sol < 0.5) return "0.25-0.50";
  if (sol < 1) return "0.50-1";
  if (sol < 5) return "1-5";
  return ">5";
}

function isExStale(row) {
  return row.skipCohort !== "stale_create";
}

function isKillGated(row) {
  return row.skipCohort === "kill_gated";
}

function cdfMembers(scored) {
  return scored.filter((s) => typeof s.rankScore === "number").map((s) => s.rankScore);
}

function includeAtDecision(feature, decisionAt) {
  if (!feature || feature.future === true || feature.kind === "future_wallet_flow") return false;
  if (typeof feature.observedAt !== "number" || typeof decisionAt !== "number") return false;
  return feature.observedAt <= decisionAt;
}

function decisionFeatures(features, decisionAt) {
  return (features || []).filter((f) => includeAtDecision(f, decisionAt));
}

function leakageReasons(features, decisionAt) {
  const reasons = [];
  for (const f of features || []) {
    if (!f) continue;
    if (f.future === true || f.kind === "future_wallet_flow") {
      reasons.push("future_wallet_flow:" + (f.name || "unknown"));
    } else if (typeof f.observedAt === "number" && typeof decisionAt === "number" && f.observedAt > decisionAt) {
      reasons.push("after_cutoff:" + (f.name || "unknown"));
    }
  }
  return reasons;
}

function recencyWeightedQuality(samples, now, variant) {
  const past = (samples || []).filter(
    (s) => s && typeof s.ts === "number" && s.ts <= now && typeof s.pnl === "number"
  );
  if (!past.length) return { value: null, n: 0, reason: "no_past_samples" };
  let used = past;
  if (variant.lastN) {
    used = [...past].sort((a, b) => a.ts - b.ts).slice(-variant.lastN);
  }
  if (!Number.isFinite(variant.halfLifeMs)) {
    return { value: mean(used.map((s) => s.pnl)), n: used.length, reason: null };
  }
  const lambda = Math.LN2 / variant.halfLifeMs;
  let wsum = 0;
  let vsum = 0;
  for (const s of used) {
    const w = Math.exp(-lambda * Math.max(0, now - s.ts));
    wsum += w;
    vsum += w * s.pnl;
  }
  if (wsum <= 0) return { value: null, n: 0, reason: "zero_weight" };
  return { value: vsum / wsum, n: used.length, reason: null };
}

function temporalSplit(rows, fractions = {}) {
  const trainF = fractions.train == null ? 0.6 : fractions.train;
  const valF = fractions.val == null ? 0.2 : fractions.val;
  const sorted = [...rows].sort(
    (a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id))
  );
  const n = sorted.length;
  const nTrain = Math.floor(n * trainF);
  const nVal = Math.floor(n * valF);
  return {
    train: sorted.slice(0, nTrain),
    val: sorted.slice(nTrain, nTrain + nVal),
    test: sorted.slice(nTrain + nVal),
  };
}

function indexCreateStream(events) {
  const byMint = new Map();
  for (const e of events || []) {
    if (!e) continue;
    const mint = e.mint || e.id;
    if (!mint || typeof e.ts !== "number") continue;
    const prev = byMint.get(mint);
    if (!prev || e.ts < prev.ts) byMint.set(mint, { mint, ts: e.ts });
  }
  return [...byMint.values()].sort((a, b) => a.ts - b.ts || String(a.mint).localeCompare(String(b.mint)));
}

/** Count creates strictly before ts, inside the prior 60s, from a full decision stream. */
function createsPrior60sAt(sortedStream, ts) {
  let n = 0;
  for (let i = sortedStream.length - 1; i >= 0; i--) {
    const pts = sortedStream[i].ts;
    if (pts >= ts) continue;
    if (pts < ts - 60_000) break;
    n++;
  }
  return n;
}

function attachCausalContext(rows, createStream) {
  const stream = indexCreateStream(
    createStream || rows.map((r) => ({ mint: r.mint || r.id, ts: r.ts }))
  );
  const sorted = [...rows].sort(
    (a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id))
  );
  for (let j = 0; j < sorted.length; j++) {
    const t = sorted[j].ts || 0;
    const createsPrior60s = createsPrior60sAt(stream, t);
    sorted[j].createsPrior60s = createsPrior60s;
    sorted[j].regime = classifyRegime(createsPrior60s);
    const knowBefore = t - OUTCOME_KNOWABLE_AFTER_MS;
    const windowStart = t - REGIME_OUTCOME_WINDOW_MS;
    let known = 0;
    let runners = 0;
    for (let i = j - 1; i >= 0; i--) {
      const p = sorted[i];
      const pts = p.ts || 0;
      if (pts > knowBefore) continue;
      if (pts < windowStart) break;
      if (typeof p.mfe !== "number") continue;
      known++;
      if (p.mfe >= 10) runners++;
    }
    sorted[j].priorKnownN = known;
    sorted[j].priorRunner10Rate = known >= 20 ? runners / known : null;
    sorted[j].launch = classifyLaunch(sorted[j]);
    sorted[j].creatorSolBucket = creatorSolBucket(sorted[j].creatorSol);
  }
  return sorted;
}

function finite(xs) {
  return xs.filter((x) => typeof x === "number" && Number.isFinite(x));
}

function median(xs) {
  const v = finite(xs);
  if (!v.length) return null;
  return pctile(v, 50);
}

function runnerRate(rows) {
  const xs = rows.filter((r) => typeof r.mfe === "number");
  if (!xs.length) return null;
  return xs.filter((r) => r.mfe >= 10).length / xs.length;
}

function sliceStats(rows) {
  return {
    n: rows.length,
    medianPnl: median(rows.map((r) => r.pnl)),
    trimPnl: trimMean(rows.map((r) => r.pnl)),
    medianMfe: median(rows.map((r) => r.mfe)),
    medianMae: median(rows.map((r) => r.mae)),
    runner10: runnerRate(rows),
  };
}

function trimMean(xs) {
  const v = finite(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length < 10) return mean(v);
  const k = Math.floor(v.length * 0.05);
  const core = v.slice(k, v.length - k || undefined);
  return mean(core.length ? core : v);
}

function scoreResolution(scores) {
  const vals = finite(scores).map((v) => Math.round(v * 100) / 100);
  const n = vals.length;
  const empty = {
    n: 0,
    unique_values: 0,
    pct_at_mode: null,
    mode: null,
    stddev: null,
    entropy: null,
    flag: null,
    p10: null,
    p25: null,
    p50: null,
    p75: null,
    p90: null,
    p95: null,
    p99: null,
  };
  if (!n) return empty;
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  let mode = null;
  let modeCount = 0;
  for (const [k, c] of counts) {
    if (c > modeCount) {
      mode = k;
      modeCount = c;
    }
  }
  const mu = mean(vals);
  let variance = 0;
  for (const v of vals) variance += (v - mu) * (v - mu);
  variance /= n;
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  const pct = modeCount / n;
  return {
    n,
    unique_values: counts.size,
    pct_at_mode: pct,
    mode,
    stddev: Math.sqrt(variance),
    entropy,
    flag: pct >= COLLAPSE_FLAG_PCT ? "SCORE_COLLAPSE" : null,
    p10: pctile(vals, 10),
    p25: pctile(vals, 25),
    p50: pctile(vals, 50),
    p75: pctile(vals, 75),
    p90: pctile(vals, 90),
    p95: pctile(vals, 95),
    p99: pctile(vals, 99),
  };
}

function sampleIdx(n, k, seed) {
  const rnd = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  const m = Math.min(k, n);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, m);
}

function kendallSafe(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n > 1200) {
    const idx = sampleIdx(n, 800, 99);
    return kendallTau(
      idx.map((i) => xs[i]),
      idx.map((i) => ys[i])
    );
  }
  return kendallTau(xs, ys);
}

function cohortBlock(rows) {
  const ranked = [...rows].sort(
    (a, b) => b.rankScore - a.rankScore || String(a.id).localeCompare(String(b.id))
  );
  const asc = [...ranked].reverse();
  const quartiles = [[], [], [], []];
  asc.forEach((r, i) => {
    const b = Math.min(3, Math.floor((i * 4) / asc.length));
    quartiles[b].push(r);
  });
  const take = (frac) => {
    if (!ranked.length) return [];
    const k = Math.max(1, Math.round(ranked.length * frac));
    return ranked.slice(0, k);
  };
  return {
    baseline: sliceStats(ranked),
    top10: sliceStats(take(0.1)),
    top5: sliceStats(take(0.05)),
    top2: sliceStats(take(0.02)),
    top1: sliceStats(take(0.01)),
    quartiles: quartiles.map(sliceStats),
  };
}

function monotonicity(quartileStats) {
  const medians = quartileStats.map((q) => q.medianPnl);
  let nondecreasing = true;
  for (let i = 1; i < medians.length; i++) {
    if (medians[i] == null || medians[i - 1] == null || medians[i] < medians[i - 1] - 1e-9) {
      nondecreasing = false;
    }
  }
  const clear =
    nondecreasing && medians[0] != null && medians[3] != null && medians[3] > medians[0];
  return { medians, label: clear ? "IMPROVING" : "MIXED", clear };
}

function permutationTest(scored, reps = 200, seed = 42) {
  const scores = scored.map((r) => r.rankScore);
  const ys = scored.map((r) => r.pnl);
  const observed = spearman(scores, ys).rho;
  const rnd = mulberry32(seed);
  const nullRhos = [];
  let ge = 0;
  const work = ys.slice();
  for (let i = 0; i < reps; i++) {
    for (let j = work.length - 1; j > 0; j--) {
      const k = Math.floor(rnd() * (j + 1));
      const tmp = work[j];
      work[j] = work[k];
      work[k] = tmp;
    }
    const rho = spearman(scores, work).rho;
    nullRhos.push(rho == null ? 0 : rho);
    if (rho != null && observed != null && rho >= observed) ge++;
  }
  nullRhos.sort((a, b) => a - b);
  const p95 = nullRhos[Math.min(nullRhos.length - 1, Math.floor(0.95 * (nullRhos.length - 1)))];
  return {
    observed,
    nullP95: p95,
    reps,
    seed,
    beatsNull: observed != null && observed > p95,
    exceedFraction: ge / reps,
  };
}

function tailDependence(scored) {
  const full = spearman(
    scored.map((r) => r.rankScore),
    scored.map((r) => r.pnl)
  ).rho;
  const out = { fullRho: full };
  for (const k of [1, 2, 5]) {
    const cut = [...scored].sort((a, b) => b.pnl - a.pnl || String(a.id).localeCompare(String(b.id))).slice(k);
    out["dropTop" + k] = spearman(
      cut.map((r) => r.rankScore),
      cut.map((r) => r.pnl)
    ).rho;
  }
  const d5 = out.dropTop5;
  out.dependent =
    full != null &&
    full >= RESEARCH_RHO_MIN &&
    (d5 == null || d5 < 0.05 || d5 < full * 0.5);
  out.label = out.dependent ? "TAIL_DEPENDENT" : "NOT_TAIL_DEPENDENT";
  return out;
}

function evaluateRanking(rows, getScore, opts = {}) {
  const reps = opts.reps == null ? 200 : opts.reps;
  const scored = [];
  let abstain = 0;
  for (const r of rows) {
    const rankScore = getScore(r);
    if (typeof rankScore !== "number" || !Number.isFinite(rankScore) || typeof r.pnl !== "number") {
      abstain++;
      continue;
    }
    scored.push({ ...r, rankScore });
  }
  const scores = scored.map((r) => r.rankScore);
  const pnls = scored.map((r) => r.pnl);
  const mfes = scored.map((r) => r.mfe);
  const sp = spearman(scores, pnls);
  const spM = spearman(scores, mfes);
  const kd = kendallSafe(scores, pnls);
  const cohorts = cohortBlock(scored);
  const mono = monotonicity(cohorts.quartiles);
  const resolution = scoreResolution(scores);
  const rest = [...scored].sort(
    (a, b) => b.rankScore - a.rankScore || String(a.id).localeCompare(String(b.id))
  );
  const k5 = Math.max(1, Math.round(rest.length * 0.05));
  const top = rest.slice(0, k5);
  const baselineRows = rest.slice(k5);
  const boot = bootstrapMedianDiff(
    top.map((r) => r.pnl),
    (baselineRows.length ? baselineRows : rest).map((r) => r.pnl),
    { nBoot: opts.nBoot == null ? 400 : opts.nBoot, seed: opts.seed == null ? 42 : opts.seed }
  );
  const permutation =
    reps > 0 && scored.length >= 12
      ? permutationTest(scored, reps, opts.seed == null ? 42 : opts.seed)
      : null;
  const tail = tailDependence(scored);
  return {
    n: scored.length,
    abstain,
    spearmanPnl: sp.rho,
    spearmanMfe: spM.rho,
    kendallPnl: kd.tau,
    kendallN: kd.n,
    resolution,
    mono,
    cohorts,
    bootstrapTop5MedianPnl: boot,
    permutation,
    tail,
  };
}

function researchGate(ev) {
  const reasons = [];
  if (!ev || ev.n < 100) reasons.push("INSUFFICIENT_SAMPLE");
  if (!(ev && ev.spearmanPnl >= RESEARCH_RHO_MIN)) reasons.push("SPEARMAN_BELOW_0.15");
  if (!(ev && ev.mono && ev.mono.clear)) reasons.push("MONOTONICITY_NOT_CLEAR");
  const top = ev && ev.cohorts && ev.cohorts.top5;
  const base = ev && ev.cohorts && ev.cohorts.baseline;
  if (!(top && base && top.medianPnl > base.medianPnl)) reasons.push("TOP5_PNL");
  if (!(top && base && top.runner10 != null && base.runner10 != null && top.runner10 > base.runner10)) {
    reasons.push("TOP5_RUNNER10");
  }
  if (!(top && base && top.medianMfe != null && base.medianMfe != null && top.medianMfe > base.medianMfe)) {
    reasons.push("TOP5_MFE");
  }
  if (!top || !base || top.medianMae == null || base.medianMae == null) {
    reasons.push("MISSING_MAE_EVIDENCE");
  } else if (top.medianMae < base.medianMae - MAE_SLACK_PP) {
    reasons.push("MAE_WORSE");
  }
  if (ev && ev.resolution && ev.resolution.pct_at_mode >= COLLAPSE_BLOCK_PCT) reasons.push("SCORE_COLLAPSE");
  if (ev && ev.permutation && !ev.permutation.beatsNull) reasons.push("PERMUTATION_NULL");
  if (ev && ev.tail && ev.tail.dependent) reasons.push("TAIL_DEPENDENT");
  return { pass: reasons.length === 0, reasons };
}

function judge(primaryEval) {
  const gate = researchGate(primaryEval);
  return {
    researchVerdict: gate.pass ? "PASS_RESEARCH" : "FAIL_RESEARCH",
    gate,
    liveStatus: "UNCHANGED",
    liveRecommendation: null,
    shadowCanPromoteLive: false,
    tradesSubmitted: false,
    killSwitchCodeTouched: false,
    liveBehaviorChanged: false,
  };
}

function pairedComparison(rows) {
  return rows.map((r) => {
    const scored = modelC(r);
    return {
      id: r.id,
      oldScore: typeof r.oldScore === "number" ? r.oldScore : null,
      newScore: scored.rankScore,
      oldConfidence: typeof r.oldConfidence === "number" ? r.oldConfidence : null,
      newConfidence: scored.confidence,
      evidenceN: scored.evidenceN,
      source: scored.source,
      oldModelVersion: OLD_MODEL,
      newModelVersion: NEW_MODEL,
      researchEpoch: NEW_EPOCH,
      featureVersion: FEATURE_VERSION,
    };
  });
}

function featureStandalone(rows, getX) {
  const xs = [];
  const pnls = [];
  const mfes = [];
  const used = [];
  let present = 0;
  for (const r of rows) {
    const x = getX(r);
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    present++;
    if (typeof r.pnl !== "number") continue;
    xs.push(x);
    pnls.push(r.pnl);
    mfes.push(r.mfe);
    used.push({ ...r, rankScore: x });
  }
  const cohorts = used.length ? cohortBlock(used) : null;
  return {
    n: used.length,
    coverage: rows.length ? present / rows.length : 0,
    spearmanPnl: spearman(xs, pnls).rho,
    spearmanMfe: spearman(xs, mfes).rho,
    quartiles: cohorts ? cohorts.quartiles : [],
  };
}

function explainScoreCollapse(rows) {
  const withOld = rows.filter((r) => typeof r.oldScore === "number");
  const at50 = withOld.filter((r) => r.oldScore === 50);
  const unknown = rows.filter((r) => !(r.deployerN >= 1));
  const unknownAt50 = unknown.filter((r) => r.oldScore === 50);
  return {
    n: rows.length,
    oldScored: withOld.length,
    pctOldAt50: withOld.length ? at50.length / withOld.length : null,
    unknownN: unknown.length,
    unknownPct: rows.length ? unknown.length / rows.length : null,
    unknownAndDisplayed50: unknownAt50.length,
    mechanism:
      "shrinkScore(raw, 0) = prior 50 for every raw quality. " +
      "Unknown deployers are stored with observations=0, then rounded. " +
      "A displayed 50 is the prior, not evidence that quality is 50.",
    demo: {
      shrinkUnknownLow: shrinkScore(10, 0),
      shrinkUnknownHigh: shrinkScore(90, 0),
      shrinkOneObs: shrinkScore(90, 1),
    },
  };
}

module.exports = {
  OLD_MODEL,
  NEW_MODEL,
  NEW_EPOCH,
  FEATURE_VERSION,
  PRIOR_QUALITY,
  PRIOR_WEIGHT,
  RESEARCH_RHO_MIN,
  COLLAPSE_FLAG_PCT,
  COLLAPSE_BLOCK_PCT,
  REGIME_COLD_LT,
  REGIME_HOT_GE,
  RECENCY_VARIANTS,
  CREATOR_SOL_BUCKETS,
  UNAVAILABLE_FEATURES,
  LINEAR_FEATURES,
  FORBIDDEN_LIVE_TEXT,
  shrinkScore,
  confidenceFromN,
  isDataBacked,
  abstain,
  modelB,
  modelC,
  fitLinearRank,
  classifyLaunch,
  classifyRegime,
  creatorSolBucket,
  isExStale,
  isKillGated,
  cdfMembers,
  includeAtDecision,
  decisionFeatures,
  leakageReasons,
  recencyWeightedQuality,
  temporalSplit,
  indexCreateStream,
  createsPrior60sAt,
  attachCausalContext,
  scoreResolution,
  evaluateRanking,
  researchGate,
  judge,
  pairedComparison,
  featureStandalone,
  explainScoreCollapse,
  permutationTest,
  tailDependence,
  sliceStats,
};
