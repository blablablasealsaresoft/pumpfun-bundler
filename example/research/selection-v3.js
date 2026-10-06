/**
 * Selection v3: downside risk and opportunity are different models.
 *
 * selection-v2-shadow stays a frozen failed opportunity ranker.
 * Its rank is eligible only as a risk feature. It is not inverted into a buy rule.
 *
 * Opportunity scores require epoch selection_v3_shadow_2026_10 and
 * decision-time wallet flow. Historical rows without those fields abstain.
 * That is COLLECT_NEW_EPOCH, not a pass.
 *
 * No live submission, sizing, or kill changes.
 */
"use strict";

const { mean, spearman, mulberry32 } = require("./math");
const v2 = require("./selection-v2");
const { isMayhemRegime } = require("./observation/canonical");
const { isEffectiveOpportunityRow, isHighConfidenceLabel } = require("./v3-collector-loader");

const V3_MODEL = "selection-v3-shadow";
const V3_EPOCH = "selection_v3_shadow_2026_10";
const OPPORTUNITY_MIN_N = 100;
const RISK_MIN_FOLD_N = 80;
const RISK_DECILE_LIFT = 0.1;
const RISK_RHO_MIN = 0.15;
const RISK_FOLDS_REQUIRED = 2;
const SUBGROUP_MIN_N = 50;
const FORBIDDEN_LIVE_TEXT = v2.FORBIDDEN_LIVE_TEXT;

const RISK_FEATURES = [
  { family: "deployer", name: "v2Rank", get: (r) => v2.modelC(r).rankScore },
  { family: "deployer", name: "deployerN", get: (r) => (typeof r.deployerN === "number" ? r.deployerN : null) },
  { family: "deployer", name: "launches1h", get: (r) => (typeof r.launches1h === "number" ? r.launches1h : null) },
  { family: "creator", name: "creatorBuySol", get: (r) => (typeof r.creatorBuySol === "number" ? r.creatorBuySol : null) },
  { family: "creator", name: "sameTxCreatorBuy", get: (r) => (r.sameTxCreatorBuy === true ? 1 : r.sameTxCreatorBuy === false ? 0 : null) },
  { family: "creator", name: "creatorSol", get: (r) => (typeof r.creatorSol === "number" ? r.creatorSol : null) },
  { family: "regime", name: "mayhem", get: (r) => (r.mayhem === true ? 1 : r.mayhem === false ? 0 : null) },
];

const OPPORTUNITY_FEATURES = [
  "uniqueBuyers",
  "buyVelocity",
  "topBuyerShare",
  "experiencedWalletCount",
  "sourceCount",
  "curveProgress",
];

function badTail(row) {
  const pnl = row.pnl;
  const mae = row.mae;
  const mfe = row.mfe;
  const pnlLe20 = typeof pnl === "number" && pnl <= -20;
  const pnlLe40 = typeof pnl === "number" && pnl <= -40;
  const maeLe30 = typeof mae === "number" && mae <= -30;
  const noPositiveMfe = typeof mfe === "number" && mfe <= 0;
  return {
    pnlLe20,
    pnlLe40,
    maeLe30,
    noPositiveMfe,
    catastrophic: pnlLe20 || maeLe30,
  };
}

function fitLinear(rows, features, labelOf) {
  const weights = {};
  const stats = {};
  for (const f of features) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const x = f.get(r);
      const y = labelOf(r);
      if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number") continue;
      xs.push(x);
      ys.push(y);
    }
    const rho = spearman(xs, ys).rho;
    const mu = mean(xs);
    let variance = 0;
    if (mu != null) {
      for (const x of xs) variance += (x - mu) * (x - mu);
      variance = xs.length ? variance / xs.length : 0;
    }
    weights[f.name] = rho == null ? 0 : rho;
    stats[f.name] = { mean: mu, std: Math.sqrt(variance), rho, n: xs.length, family: f.family || null };
  }
  return { weights, stats };
}

function scoreLinear(row, features, fit) {
  let s = 0;
  let used = 0;
  const components = {};
  for (const f of features) {
    const w = fit.weights[f.name];
    const x = f.get(row);
    if (!w || typeof x !== "number" || !Number.isFinite(x)) {
      components[f.name] = null;
      continue;
    }
    const st = fit.stats[f.name];
    const z = st.std > 1e-9 && st.mean != null ? (x - st.mean) / st.std : 0;
    const contrib = w * z;
    components[f.name] = contrib;
    s += contrib;
    used++;
  }
  return { value: used ? s : null, used, components };
}

function fitRisk(train, features = RISK_FEATURES) {
  const fit = fitLinear(train, features, (r) => (badTail(r).catastrophic ? 1 : 0));
  function score(row) {
    const scored = scoreLinear(row, features, fit);
    if (scored.value == null) {
      return {
        riskScore: null,
        riskConfidence: 0,
        abstainReason: "no_risk_features",
        components: scored.components,
      };
    }
    return {
      riskScore: scored.value,
      riskConfidence: Math.min(1, scored.used / features.length),
      abstainReason: null,
      components: scored.components,
    };
  }
  return { weights: fit.weights, stats: fit.stats, score, features };
}

function auc(scores, labels) {
  const pos = [];
  const neg = [];
  for (let i = 0; i < scores.length; i++) {
    if (labels[i] === 1) pos.push(scores[i]);
    else if (labels[i] === 0) neg.push(scores[i]);
  }
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  let ties = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins++;
      else if (p === n) ties++;
    }
  }
  return (wins + 0.5 * ties) / (pos.length * neg.length);
}

function averagePrecision(scores, labels) {
  const rows = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => b.s - a.s);
  let hits = 0;
  let ap = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].y === 1) {
      hits++;
      ap += hits / (i + 1);
    }
  }
  const total = labels.filter((y) => y === 1).length;
  return total ? ap / total : null;
}

function evalRiskFold(train, test, features = RISK_FEATURES) {
  const model = fitRisk(train, features);
  const scored = [];
  for (const r of test) {
    if (typeof r.pnl !== "number") continue;
    const s = model.score(r);
    if (s.riskScore == null) continue;
    scored.push({ ...r, riskScore: s.riskScore, y: badTail(r).catastrophic ? 1 : 0 });
  }
  const scores = scored.map((r) => r.riskScore);
  const labels = scored.map((r) => r.y);
  const baseRate = labels.length ? mean(labels) : null;
  const ranked = [...scored].sort((a, b) => b.riskScore - a.riskScore || String(a.id).localeCompare(String(b.id)));
  const k = Math.max(1, Math.round(ranked.length * 0.1));
  const decile = ranked.slice(0, k);
  const decileRate = decile.length ? mean(decile.map((r) => r.y)) : null;
  const rho = spearman(scores, labels).rho;
  const passFold =
    scored.length >= RISK_MIN_FOLD_N &&
    decileRate != null &&
    baseRate != null &&
    decileRate >= baseRate + RISK_DECILE_LIFT &&
    rho != null &&
    rho >= RISK_RHO_MIN;
  return {
    n: scored.length,
    baseRate,
    decileRate,
    lift: decileRate != null && baseRate != null ? decileRate - baseRate : null,
    rho,
    auc: scored.length ? auc(scores, labels) : null,
    averagePrecision: scored.length ? averagePrecision(scores, labels) : null,
    passFold,
    model,
    scored,
  };
}

function walkForwardFolds(rows) {
  const sorted = [...rows].sort(
    (a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id))
  );
  const q = Math.floor(sorted.length / 4);
  if (q < 1) return [];
  const chunks = [0, 1, 2, 3].map((i) => sorted.slice(i * q, i === 3 ? sorted.length : (i + 1) * q));
  return [1, 2, 3].map((i) => ({
    name: "fold" + i,
    train: chunks.slice(0, i).flat(),
    test: chunks[i],
  }));
}

function assertFoldIsolation(fold) {
  if (!fold.train.length || !fold.test.length) return;
  const maxTrain = Math.max(...fold.train.map((r) => r.ts || 0));
  const minTest = Math.min(...fold.test.map((r) => r.ts || 0));
  if (minTest < maxTrain) throw new Error("temporal fold overlap");
}

function ablation(train, test) {
  const full = evalRiskFold(train, test, RISK_FEATURES);
  const families = ["deployer", "creator", "regime"];
  const rows = families.map((family) => {
    const kept = RISK_FEATURES.filter((f) => f.family !== family);
    const without = evalRiskFold(train, test, kept);
    return {
      family,
      rhoFull: full.rho,
      rhoWithout: without.rho,
      deltaRho: full.rho != null && without.rho != null ? full.rho - without.rho : null,
      decileFull: full.decileRate,
      decileWithout: without.decileRate,
    };
  });
  for (const family of ["walletFlow", "listener", "curve", "venue", "cost"]) {
    rows.push({
      family,
      rhoFull: full.rho,
      rhoWithout: null,
      deltaRho: null,
      note: "not_in_historical_decision_rows",
    });
  }
  return { full, rows };
}

function judgeRisk(folds) {
  const passed = folds.filter((f) => f.passFold).length;
  const pass = passed >= RISK_FOLDS_REQUIRED;
  return {
    researchVerdict: pass ? "PASS_RISK_RESEARCH" : "FAIL_RISK_RESEARCH",
    passedFolds: passed,
    requiredFolds: RISK_FOLDS_REQUIRED,
    liveStatus: "UNCHANGED",
    liveRecommendation: null,
    shadowCanPromoteLive: false,
  };
}

function v3Rows(rows) {
  return rows.filter((r) => r.researchEpoch === V3_EPOCH);
}

function hasDecisionWalletFlow(row) {
  const flow = row.walletFlowDecision;
  return !!(flow && typeof flow.uniqueBuyers === "number");
}

function judgeOpportunityPass(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ranked = list.filter((r) => !r.excludedForLeakage && hasDecisionWalletFlow(r) && typeof r.pnl === "number");
  const missingMae = ranked.filter((r) => typeof r.mae !== "number" || typeof r.mfe !== "number");
  const complete = ranked.filter((r) => typeof r.mae === "number" && typeof r.mfe === "number");
  if (ranked.length >= OPPORTUNITY_MIN_N && missingMae.length && complete.length < OPPORTUNITY_MIN_N) {
    return {
      researchVerdict: "FAIL_OPPORTUNITY_RESEARCH",
      reason: "MISSING_MAE_EVIDENCE",
      pass: false,
    };
  }
  if (complete.length >= OPPORTUNITY_MIN_N) {
    return {
      researchVerdict: "HOLD_FOR_WALK_FORWARD",
      reason: "walk-forward can run; PASS_OPPORTUNITY_RESEARCH is not automatic",
      pass: false,
    };
  }
  return {
    researchVerdict: "COLLECT_NEW_EPOCH",
    reason: "effective new-epoch rows with decision-time wallet flow, complete outcomes, and no leakage are below " + OPPORTUNITY_MIN_N,
    pass: false,
  };
}

function evaluateOpportunity(rows) {
  const sorted = [...(rows || [])].sort(
    (a, b) => (a.decisionCutoffAt || a.ts || 0) - (b.decisionCutoffAt || b.ts || 0) || String(a.id).localeCompare(String(b.id))
  );
  const effective = sorted.filter(isEffectiveOpportunityRow);
  const passGate = judgeOpportunityPass(sorted);
  const ready = effective.length >= OPPORTUNITY_MIN_N;
  const folds = [];
  let opportunityScored = 0;
  let opportunityAbstain = 0;
  if (ready) {
    const timed = effective.map((r) => ({ ...r, ts: r.decisionCutoffAt }));
    for (const fold of walkForwardFolds(timed)) {
      assertFoldIsolation(fold);
      const model = fitOpportunity(fold.train);
      const testScored = fold.test.map((r) => {
        const s = model.score(r);
        return { ...r, opportunityScore: s.opportunityScore, abstainReason: s.abstainReason };
      });
      const usable = testScored.filter((r) => typeof r.opportunityScore === "number" && typeof r.pnl === "number");
      const high = usable.filter(isHighConfidenceLabel);
      opportunityScored += usable.length;
      opportunityAbstain += testScored.length - usable.length;
      folds.push({
        name: fold.name,
        n: usable.length,
        highN: high.length,
        rhoPnl: spearman(usable.map((r) => r.opportunityScore), usable.map((r) => r.pnl)).rho,
        rhoMfe: spearman(usable.map((r) => r.opportunityScore), usable.map((r) => r.mfe)).rho,
        rhoPnlHighConfidence: spearman(high.map((r) => r.opportunityScore), high.map((r) => r.pnl)).rho,
      });
    }
  }
  const status = ready ? "HOLD_FOR_WALK_FORWARD" : "COLLECT_NEW_EPOCH";
  return {
    status,
    researchVerdict: status,
    passGate,
    v3Rows: sorted.length,
    decisionTimeFlowRows: sorted.filter((r) => !r.excludedForLeakage && hasDecisionWalletFlow(r)).length,
    effectiveN: effective.length,
    required: OPPORTUNITY_MIN_N,
    walkForwardEligible: ready,
    folds,
    opportunityScored: ready ? opportunityScored : 0,
    opportunityAbstain: ready ? opportunityAbstain : sorted.length,
    highConfidenceN: effective.filter(isHighConfidenceLabel).length,
    leakageExcluded: sorted.filter((r) => r.excludedForLeakage).length,
    reason: ready
      ? "effective new-epoch sample meets the walk-forward gate; this is not PASS_OPPORTUNITY_RESEARCH"
      : "effective joined rows with decision-time wallet flow, pnl, mfe, mae, and no leakage are below " + OPPORTUNITY_MIN_N,
  };
}

function opportunityStatus(rows) {
  return evaluateOpportunity(v3Rows(rows));
}

function fitOpportunity(train) {
  const usable = train.filter((r) => r.researchEpoch === V3_EPOCH && hasDecisionWalletFlow(r) && typeof r.pnl === "number");
  if (usable.length < 30) {
    return {
      ready: false,
      score() {
        return {
          opportunityScore: null,
          opportunityConfidence: 0,
          abstainReason: "insufficient_v3_train",
          components: {},
        };
      },
    };
  }
  const features = OPPORTUNITY_FEATURES.map((name) => ({
    family: "walletFlow",
    name,
    get: (r) => {
      const flow = r.walletFlowDecision || {};
      const v = flow[name];
      return typeof v === "number" ? v : null;
    },
  }));
  const fit = fitLinear(usable, features, (r) => r.pnl);
  return {
    ready: true,
    score(row) {
      if (row.researchEpoch !== V3_EPOCH || !hasDecisionWalletFlow(row)) {
        return {
          opportunityScore: null,
          opportunityConfidence: 0,
          abstainReason: row.researchEpoch === V3_EPOCH ? "wallet_flow_missing" : "not_v3_epoch",
          components: {},
        };
      }
      if (isMayhemRegime(row)) {
        return {
          opportunityScore: null,
          opportunityConfidence: 0,
          abstainReason: "mayhem_separate_regime",
          components: {},
        };
      }
      const scored = scoreLinear(row, features, fit);
      return {
        opportunityScore: scored.value,
        opportunityConfidence: scored.used ? Math.min(1, scored.used / features.length) : 0,
        abstainReason: scored.value == null ? "no_opportunity_features" : null,
        components: scored.components,
      };
    },
  };
}

function selectionV3(row, riskModel) {
  const risk = riskModel
    ? riskModel.score(row)
    : { riskScore: null, riskConfidence: 0, abstainReason: "no_risk_model", components: {} };
  const opp = fitOpportunity([]).score(row);
  return {
    downsideRisk: {
      score: risk.riskScore,
      confidence: risk.riskConfidence,
      reasonComponents: risk.components || {},
    },
    opportunity: {
      score: opp.opportunityScore,
      confidence: opp.opportunityConfidence,
      reasonComponents: opp.components || {},
    },
    riskScore: risk.riskScore,
    riskConfidence: risk.riskConfidence,
    opportunityScore: opp.opportunityScore,
    opportunityConfidence: opp.opportunityConfidence,
    abstainReason: opp.abstainReason,
    executionImpact: "none",
    maySubmit: false,
  };
}

function pairedRow(row, riskModel) {
  const v3 = selectionV3(row, riskModel);
  return {
    id: row.id,
    oldScore: typeof row.oldScore === "number" ? row.oldScore : null,
    v2Score: v2.modelC(row).rankScore,
    v3Risk: v3.riskScore,
    v3Opportunity: v3.opportunityScore,
    outcome: row.pnl ?? null,
    oldModelVersion: v2.OLD_MODEL,
    v2ModelVersion: v2.NEW_MODEL,
    v3ModelVersion: V3_MODEL,
    v2Epoch: v2.NEW_EPOCH,
    v3Epoch: V3_EPOCH,
  };
}

function subgroupSlice(scored, pred) {
  const rows = scored.filter(pred);
  return {
    n: rows.length,
    status: rows.length >= SUBGROUP_MIN_N ? "ok" : "insufficient",
    catastrophicRate: rows.length ? mean(rows.map((r) => r.y)) : null,
  };
}

function evaluateProgram(input) {
  const rows = Array.isArray(input) ? input : (input && input.riskRows) || [];
  const opportunityRows = Array.isArray(input) ? [] : (input && input.opportunityRows) || [];
  const ex = rows.filter(v2.isExStale);
  const foldsIn = walkForwardFolds(ex);
  const folds = [];
  for (const fold of foldsIn) {
    assertFoldIsolation(fold);
    const result = evalRiskFold(fold.train, fold.test);
    folds.push({
      name: fold.name,
      trainN: fold.train.length,
      testN: fold.test.length,
      n: result.n,
      baseRate: result.baseRate,
      decileRate: result.decileRate,
      lift: result.lift,
      rho: result.rho,
      auc: result.auc,
      averagePrecision: result.averagePrecision,
      passFold: result.passFold,
      scored: result.scored,
      model: result.model,
    });
  }
  const last = foldsIn[foldsIn.length - 1];
  const ab = last ? ablation(last.train, last.test) : { full: null, rows: [] };
  const risk = judgeRisk(folds);
  const opportunity = evaluateOpportunity(opportunityRows);
  if (opportunity.researchVerdict === "PASS_OPPORTUNITY_RESEARCH" || opportunity.passGate.pass === true) {
    throw new Error("opportunity evaluation tried to emit a research pass");
  }
  const lastScored = folds.length ? folds[folds.length - 1].scored : [];
  const subgroups = {
    exStale: { n: ex.length, status: ex.length >= SUBGROUP_MIN_N ? "ok" : "insufficient" },
    killGated: subgroupSlice(lastScored, (r) => r.skipCohort === "kill_gated"),
    mayhem: subgroupSlice(lastScored, (r) => r.mayhem === true),
    standard: subgroupSlice(lastScored, (r) => r.mayhem !== true),
    customPair: subgroupSlice(lastScored, (r) => r.isCustomPair === true),
    letsBonk: subgroupSlice(lastScored, (r) => r.platform === "lets_bonk"),
  };
  return {
    risk,
    opportunity,
    folds: folds.map((f) => {
      const copy = { ...f };
      delete copy.scored;
      delete copy.model;
      return copy;
    }),
    ablation: ab.rows,
    subgroups,
    liveStatus: "UNCHANGED",
    shadowCanPromoteLive: false,
    tradesSubmitted: false,
    killSwitchCodeTouched: false,
    liveBehaviorChanged: false,
  };
}

function deterministicShuffle(values, seed) {
  const rnd = mulberry32(seed);
  const xs = values.slice();
  for (let j = xs.length - 1; j > 0; j--) {
    const k = Math.floor(rnd() * (j + 1));
    const tmp = xs[j];
    xs[j] = xs[k];
    xs[k] = tmp;
  }
  return xs;
}

module.exports = {
  V3_MODEL,
  V3_EPOCH,
  OPPORTUNITY_MIN_N,
  RISK_MIN_FOLD_N,
  RISK_DECILE_LIFT,
  RISK_RHO_MIN,
  RISK_FOLDS_REQUIRED,
  SUBGROUP_MIN_N,
  RISK_FEATURES,
  OPPORTUNITY_FEATURES,
  FORBIDDEN_LIVE_TEXT,
  badTail,
  fitRisk,
  evalRiskFold,
  walkForwardFolds,
  assertFoldIsolation,
  ablation,
  judgeRisk,
  opportunityStatus,
  evaluateOpportunity,
  judgeOpportunityPass,
  fitOpportunity,
  selectionV3,
  pairedRow,
  subgroupSlice,
  evaluateProgram,
  deterministicShuffle,
  auc,
  averagePrecision,
  isMayhemRegime,
};
