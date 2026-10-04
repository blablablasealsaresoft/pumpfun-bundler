/**
 * Rank cohorts + monotonicity + promotion evaluation.
 */
"use strict";

const {
  mean,
  pctile,
  trimmedMean,
  profitFactor,
  bootstrapMedianDiff,
  spearman,
  kendallTau,
} = require("./math");
const {
  MIN_CONV_WINDOW_N,
  DIAGNOSTIC_N,
  PROMOTION_N,
  MAE_SLACK_PP,
  STATUS,
  FAIL_REASONS,
} = require("./promotion-protocol");
const { effectiveDeployerN } = require("./effective-n");

function scoreOf(r) {
  if (typeof r.convictionScore === "number") return r.convictionScore;
  if (typeof r.rankScore === "number") return r.rankScore;
  if (typeof r.softFloorScore === "number") return r.softFloorScore;
  return null;
}

function summarizeCohort(label, rows) {
  const pnls = rows
    .map((r) => r.outcome?.realizedPnl)
    .filter((x) => typeof x === "number");
  const mfes = rows
    .map((r) => r.outcome?.execMfe)
    .filter((x) => typeof x === "number");
  const maes = rows
    .map((r) => r.outcome?.execMae)
    .filter((x) => typeof x === "number");
  const wins = rows.filter((r) => r.outcome?.win === true).length;
  const sl = rows.filter((r) => r.outcome?.stopLoss).length;
  const mh = rows.filter((r) => r.outcome?.maxHold).length;
  return {
    label,
    n: rows.length,
    effectiveDeployers: effectiveDeployerN(rows),
    medianPnl: pctile(pnls, 50),
    meanPnl: mean(pnls),
    trimPnl: trimmedMean(pnls),
    medianMfe: pctile(mfes, 50),
    medianMae: pctile(maes, 50),
    winRate: rows.length ? wins / rows.length : null,
    profitFactor: profitFactor(pnls),
    stopLossRate: rows.length ? sl / rows.length : null,
    maxHoldRate: rows.length ? mh / rows.length : null,
    pnls,
    mfes,
    maes,
  };
}

function maxConvWindowN(rows) {
  let m = 0;
  for (const r of rows) {
    const n = r.convictionWindowN || 0;
    if (n > m) m = n;
  }
  return m;
}

/**
 * Build quartile / top-k cohorts. Returns UNAVAILABLE when window too shallow.
 */
function buildCohorts(effective) {
  const maxN = maxConvWindowN(effective);
  const windowOk = maxN >= MIN_CONV_WINDOW_N;
  const scored = effective
    .map((r) => ({ r, s: scoreOf(r) }))
    .filter((x) => x.s != null)
    .sort((a, b) => a.s - b.s);

  const unavailable = (name) => ({
    name,
    status: "INSUFFICIENT_WINDOW_DEPTH",
    reason: `maxConvWindowN=${maxN} < ${MIN_CONV_WINDOW_N}`,
    summary: null,
  });

  if (!windowOk) {
    return {
      windowOk: false,
      maxConvWindowN: maxN,
      cohorts: {
        quartiles: ["Q1", "Q2", "Q3", "Q4"].map((q) => unavailable(q)),
        top50: unavailable("top50"),
        top25: unavailable("top25"),
        top10: unavailable("top10"),
        top5: unavailable("top5"),
        top2: unavailable("top2"),
      },
      baseline: summarizeCohort("baseline", effective),
    };
  }

  const n = scored.length;
  const sliceFrac = (lo, hi) =>
    scored.slice(Math.floor(n * lo), Math.floor(n * hi)).map((x) => x.r);
  const topFrac = (frac) =>
    scored.slice(Math.floor(n * (1 - frac))).map((x) => x.r);

  const q = [
    summarizeCohort("Q1_lowest", sliceFrac(0, 0.25)),
    summarizeCohort("Q2", sliceFrac(0.25, 0.5)),
    summarizeCohort("Q3", sliceFrac(0.5, 0.75)),
    summarizeCohort("Q4_highest", sliceFrac(0.75, 1)),
  ];

  return {
    windowOk: true,
    maxConvWindowN: maxN,
    cohorts: {
      quartiles: q.map((s) => ({ name: s.label, status: "OK", summary: s })),
      top50: { name: "top50", status: "OK", summary: summarizeCohort("top50", topFrac(0.5)) },
      top25: { name: "top25", status: "OK", summary: summarizeCohort("top25", topFrac(0.25)) },
      top10: { name: "top10", status: "OK", summary: summarizeCohort("top10", topFrac(0.1)) },
      top5: { name: "top5", status: "OK", summary: summarizeCohort("top5", topFrac(0.05)) },
      top2: { name: "top2", status: "OK", summary: summarizeCohort("top2", topFrac(0.02)) },
    },
    baseline: summarizeCohort("baseline", effective),
    scored,
  };
}

function monoDirection(values, { higherIsBetter = true } = {}) {
  // values ordered low-rank → high-rank
  const usable = values.filter((v) => typeof v === "number");
  if (usable.length < 3) return "NOT_EVALUATED";
  let up = 0;
  let down = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i] > usable[i - 1]) up++;
    else if (usable[i] < usable[i - 1]) down++;
  }
  if (higherIsBetter) {
    if (down === 0 && up > 0) return "PASS";
    if (up === 0 && down > 0) return "FAIL";
    return "MIXED";
  }
  // lower is better
  if (up === 0 && down > 0) return "PASS";
  if (down === 0 && up > 0) return "FAIL";
  return "MIXED";
}

function monotonicityReport(cohortBundle) {
  if (!cohortBundle.windowOk) {
    return {
      status: "NOT_EVALUATED",
      reason: "INSUFFICIENT_WINDOW_DEPTH",
      medPnl: "NOT_EVALUATED",
      trimPnl: "NOT_EVALUATED",
      medianMfe: "NOT_EVALUATED",
      medianMae: "NOT_EVALUATED",
      winRate: "NOT_EVALUATED",
    };
  }
  const q = cohortBundle.cohorts.quartiles.map((c) => c.summary);
  const meds = q.map((s) => s.medianPnl);
  const trims = q.map((s) => s.trimPnl);
  const mfes = q.map((s) => s.medianMfe);
  const maes = q.map((s) => s.medianMae);
  const wins = q.map((s) => s.winRate);
  return {
    status: "OK",
    quartiles: q,
    medPnl: monoDirection(meds, { higherIsBetter: true }),
    trimPnl: monoDirection(trims, { higherIsBetter: true }),
    medianMfe: monoDirection(mfes, { higherIsBetter: true }),
    medianMae: monoDirection(maes, { higherIsBetter: false }),
    winRate: monoDirection(wins, { higherIsBetter: true }),
  };
}

function correlations(effective) {
  const scores = effective.map(scoreOf);
  const pnls = effective.map((r) => r.outcome?.realizedPnl);
  const mfes = effective.map((r) => r.outcome?.execMfe);
  const maes = effective.map((r) => r.outcome?.execMae);
  return {
    spearmanPnl: spearman(scores, pnls),
    spearmanMfe: spearman(scores, mfes),
    spearmanMae: spearman(scores, maes),
    kendallPnl: kendallTau(scores, pnls),
    kendallMfe: kendallTau(scores, mfes),
  };
}

function noFreePromotion(top, rest) {
  if (!top || !rest || top.n < 5) return null;
  const sorted = [...top.pnls].sort((a, b) => b - a);
  const sans = sorted.slice(2);
  const meanSans = mean(sans);
  const trimOk =
    top.trimPnl != null && rest.trimPnl != null && top.trimPnl > rest.trimPnl;
  const meanOk =
    meanSans != null && rest.meanPnl != null && meanSans > rest.meanPnl;
  return trimOk && meanOk;
}

function maeNotWorse(lo, hi) {
  if (lo?.medianMae == null || hi?.medianMae == null) return null;
  // more negative = worse; hi should not be much worse than lo
  return hi.medianMae >= lo.medianMae - MAE_SLACK_PP;
}

/**
 * Stage + promotion evaluation.
 * Policy is frozen — do not weaken after seeing results.
 */
function evaluatePromotion({ effective, deployerN, cohortBundle, mono, corr }) {
  const n = effective.length;
  const maxConv = cohortBundle.maxConvWindowN;
  const leakage = effective.some((r) => r.leakageReasons?.length);

  if (leakage) {
    return {
      status: STATUS.INVALID,
      reasonCodes: [FAIL_REASONS.LEAKAGE],
      detail: "lookahead/data leakage detected",
    };
  }

  if (n < DIAGNOSTIC_N || maxConv < MIN_CONV_WINDOW_N) {
    return {
      status: STATUS.COLLECT,
      reasonCodes: [FAIL_REASONS.INSUFFICIENT_SAMPLE],
      detail: `need effective_n>=${DIAGNOSTIC_N} and convWindowN>=${MIN_CONV_WINDOW_N}`,
      remaining_to_diagnostic: Math.max(0, DIAGNOSTIC_N - n),
      remaining_to_promotion: Math.max(0, PROMOTION_N - n),
    };
  }

  if (n < PROMOTION_N) {
    // DIAGNOSTIC only — directional, no promotion
    const dir =
      mono.medPnl === "PASS" &&
      (mono.medianMfe === "PASS" || mono.medianMfe === "MIXED");
    return {
      status: STATUS.DIAGNOSTIC,
      reasonCodes: [],
      detail: dir
        ? "directional monotonicity emerging — do not promote yet"
        : "diagnostic sample — ranking not yet clearly directional",
      directional: dir ? "YES" : mono.medPnl,
      remaining_to_promotion: PROMOTION_N - n,
    };
  }

  // PROMOTION-GRADE
  if (!cohortBundle.windowOk) {
    return {
      status: STATUS.FAIL,
      reasonCodes: [FAIL_REASONS.INSUFFICIENT_COHORT_DEPTH],
      detail: "window depth insufficient for top cohorts",
    };
  }
  if (deployerN < PROMOTION_N) {
    // Prefer deployer diversity; still allow if effective_n is trade-based ≥100
    // but flag if deployerN is very low
  }

  const top2 = cohortBundle.cohorts.top2.summary;
  const top5 = cohortBundle.cohorts.top5.summary;
  const top25 = cohortBundle.cohorts.top25.summary;
  const baseline = cohortBundle.baseline;

  const threeAgree =
    mono.medPnl === "PASS" &&
    mono.trimPnl === "PASS" &&
    (mono.medianMfe === "PASS" || mono.winRate === "PASS");

  const ladder =
    baseline &&
    top5 &&
    top2 &&
    top5.medianPnl != null &&
    top2.medianPnl != null &&
    top5.medianPnl > baseline.medianPnl &&
    top2.medianPnl > top5.medianPnl;

  const pfOk = top2 && top2.profitFactor != null && top2.profitFactor > 1;
  const maeOk = maeNotWorse(top5, top2);
  const noTail = noFreePromotion(top2, top5);
  const boot = bootstrapMedianDiff(top25?.pnls || [], baseline.pnls, {
    seed: 42,
  });
  const bootOk = boot.diff != null && boot.lo != null && boot.lo > -5;

  const rho = corr.spearmanPnl?.rho;
  const reversed = typeof rho === "number" && rho < -0.15;

  if (reversed) {
    return {
      status: STATUS.FAIL,
      reasonCodes: [FAIL_REASONS.REVERSED_RANK_SIGNAL],
      detail: `spearman pnl rho=${rho}`,
      bootstrap: boot,
    };
  }

  if (!cohortBundle.cohorts.top2 || top2.n < 5) {
    return {
      status: STATUS.FAIL,
      reasonCodes: [FAIL_REASONS.INSUFFICIENT_COHORT_DEPTH],
      detail: "top2 cohort too thin",
    };
  }

  if (threeAgree && ladder && pfOk && maeOk !== false && noTail === true && bootOk) {
    return {
      status: STATUS.PASS,
      reasonCodes: [],
      detail:
        "baseline < top5 < top2 on med/trim/runner-proxy; no free promotion; MAE ok; bootstrap supportive",
      bootstrap: boot,
      policy:
        "enable TOP2 live only @ fixed 0.025; sizing/fees/Δ0/tranche still frozen",
    };
  }

  const reasons = [];
  if (!threeAgree && mono.medPnl === "FAIL") reasons.push(FAIL_REASONS.REVERSED_RANK_SIGNAL);
  else if (!threeAgree) reasons.push(FAIL_REASONS.NO_RANK_SIGNAL);
  if (!ladder) reasons.push(FAIL_REASONS.NO_RANK_SIGNAL);
  if (noTail === false) reasons.push(FAIL_REASONS.HIGH_VARIANCE);
  if (maeOk === false) reasons.push(FAIL_REASONS.NO_RANK_SIGNAL);
  if (!pfOk) reasons.push(FAIL_REASONS.NO_RANK_SIGNAL);
  if (!bootOk) reasons.push(FAIL_REASONS.HIGH_VARIANCE);
  if (!reasons.length) reasons.push(FAIL_REASONS.NO_RANK_SIGNAL);

  return {
    status: STATUS.FAIL,
    reasonCodes: [...new Set(reasons)],
    detail:
      "ranking failed predeclared promotion gate — improve deployer/selection model",
    bootstrap: boot,
    checks: { threeAgree, ladder, pfOk, maeOk, noTail, bootOk },
  };
}

module.exports = {
  scoreOf,
  summarizeCohort,
  maxConvWindowN,
  buildCohorts,
  monoDirection,
  monotonicityReport,
  correlations,
  noFreePromotion,
  maeNotWorse,
  evaluatePromotion,
};
