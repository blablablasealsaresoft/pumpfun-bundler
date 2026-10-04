#!/usr/bin/env node
/**
 * Deterministic tests for the measurement-only promotion harness.
 * Run: node example/research/promotion-harness.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { execPathPeaks, spearman, kendallTau, bootstrapMedianDiff, mulberry32 } = require("./math");
const { toResearchRecord, classifyOutcome, detectLeakage, researchIdentity } = require("./records");
const { filterEffective } = require("./effective-n");
const {
  buildCohorts,
  monotonicityReport,
  evaluatePromotion,
  monoDirection,
  correlations,
} = require("./evaluate");
const {
  RESEARCH_EPOCH,
  DIAGNOSTIC_N,
  PROMOTION_N,
  MIN_CONV_WINDOW_N,
  STATUS,
  OUTCOME_STATUS,
} = require("./promotion-protocol");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name);
    console.error("      " + (e && e.message ? e.message : e));
  }
}

function mkRecord(overrides = {}) {
  const base = {
    candidateId: overrides.candidateId || `id-${Math.random()}`,
    mint: overrides.mint || "Mint111",
    deployer: overrides.deployer || "Dep111",
    detectedAt: 1,
    decisionAt: 2,
    modelVersion: "deployer85-shrink-v1",
    featureVersion: "decision-time-v1",
    researchEpoch: RESEARCH_EPOCH,
    sampleSegment: "post_fix",
    convictionScore: 50,
    rankScore: 50,
    softFloorScore: 50,
    deployerScore: 50,
    selected: true,
    sampleKind: "live_selected",
    selectionReason: "buy",
    knownAtDecision: false,
    convictionWindowN: MIN_CONV_WINDOW_N,
    percentileAtDecision: 50,
    leakageReasons: [],
    outcome: {
      status: OUTCOME_STATUS.COMPLETE,
      realizedPnl: -10,
      execMfe: -5,
      execMae: -20,
      win: false,
      stopLoss: false,
      maxHold: true,
      exitReason: "MAX_HOLD",
      horizonMs: 8000,
      complete: true,
    },
  };
  return {
    ...base,
    ...overrides,
    outcome: { ...base.outcome, ...(overrides.outcome || {}) },
  };
}

// 1. effective_n inclusion/exclusion
test("effective_n inclusion/exclusion", () => {
  const rows = [
    mkRecord({ candidateId: "a", mint: "A" }),
    mkRecord({
      candidateId: "b",
      mint: "B",
      outcome: { status: "censored", complete: false, realizedPnl: null },
    }),
    mkRecord({ candidateId: "c", mint: "C", convictionScore: null, rankScore: null, softFloorScore: null }),
  ];
  const f = filterEffective(rows, { universe: "live_selected" });
  assert.strictEqual(f.effective_n, 1);
  assert.ok(f.exclusions.censored_outcome >= 1);
  assert.ok(f.exclusions.missing_conviction >= 1);
});

// 2. duplicate removal
test("duplicate removal", () => {
  const rows = [
    mkRecord({ candidateId: "x", mint: "M1" }),
    mkRecord({ candidateId: "x", mint: "M1" }),
    mkRecord({ candidateId: "y", mint: "M1" }), // same mint buy
  ];
  const f = filterEffective(rows, { universe: "live_selected" });
  assert.strictEqual(f.effective_n, 1);
  assert.ok(f.exclusions.duplicate >= 2);
});

// 3. missing outcome exclusion
test("missing outcome exclusion", () => {
  const rows = [
    mkRecord({
      candidateId: "m",
      mint: "M",
      outcome: { status: "missing", complete: false, realizedPnl: null },
    }),
  ];
  const f = filterEffective(rows, { universe: "live_selected" });
  assert.strictEqual(f.effective_n, 0);
  assert.ok(f.exclusions.missing_outcome >= 1);
});

// 4. censored outcome behavior
test("censored outcome behavior", () => {
  const o = classifyOutcome({ decision: "buy", mint: "X" }, null);
  assert.strictEqual(o.status, OUTCOME_STATUS.CENSORED);
  assert.strictEqual(o.realizedPnl, null);
  assert.strictEqual(o.complete, false);
});

// 5. decision-time score immutability
test("decision-time score immutability", () => {
  const d = {
    mint: "M",
    createSig: "S",
    decision: "buy",
    ts: 100,
    globalConvPct: 77,
    globalConvN: 120,
    sampleSegment: "post_fix",
    modelVersion: "v1",
  };
  const r1 = toResearchRecord(d, {
    mint: "M",
    pnlPct: 5,
    executableMfePct: 10,
    executableMaePct: -3,
    exitReason: "MAX_HOLD",
    holdMs: 8000,
  });
  d.globalConvPct = 99; // later mutation of source object
  assert.strictEqual(r1.convictionScore, 77);
  assert.strictEqual(r1.percentileAtDecision, 77);
});

// 6. epoch isolation
test("epoch isolation", () => {
  const rows = [
    mkRecord({ candidateId: "p", mint: "P", researchEpoch: RESEARCH_EPOCH, sampleSegment: "post_fix" }),
    mkRecord({
      candidateId: "q",
      mint: "Q",
      researchEpoch: "pre_fix",
      sampleSegment: "pre_fix",
    }),
  ];
  const f = filterEffective(rows, { epoch: RESEARCH_EPOCH, universe: "live_selected" });
  assert.strictEqual(f.effective_n, 1);
  assert.ok(f.exclusions.wrong_epoch >= 1);
});

// 7. cohort construction
test("cohort construction when window deep", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(
      mkRecord({
        candidateId: "c" + i,
        mint: "M" + i,
        deployer: "D" + (i % 10),
        convictionScore: i,
        convictionWindowN: MIN_CONV_WINDOW_N,
        outcome: {
          realizedPnl: i - 20,
          execMfe: i - 15,
          execMae: -30 + i * 0.1,
          win: i - 20 > 0,
          complete: true,
          status: "complete",
        },
      })
    );
  }
  const b = buildCohorts(rows);
  assert.strictEqual(b.windowOk, true);
  assert.strictEqual(b.cohorts.quartiles[0].status, "OK");
  assert.ok(b.cohorts.top5.summary.n > 0);
});

// 8. unavailable top-N when window shallow
test("unavailable top-N cohort behavior", () => {
  const rows = [
    mkRecord({ candidateId: "s1", mint: "S1", convictionWindowN: 70 }),
    mkRecord({ candidateId: "s2", mint: "S2", convictionWindowN: 70 }),
  ];
  const b = buildCohorts(rows);
  assert.strictEqual(b.windowOk, false);
  assert.strictEqual(b.cohorts.top5.status, "INSUFFICIENT_WINDOW_DEPTH");
  assert.strictEqual(b.cohorts.top2.status, "INSUFFICIENT_WINDOW_DEPTH");
});

// 9. monotonic ranking example
test("monotonic ranking example", () => {
  assert.strictEqual(monoDirection([-20, -10, 0, 10]), "PASS");
});

// 10. reversed ranking example
test("reversed ranking example", () => {
  assert.strictEqual(monoDirection([10, 0, -10, -20]), "FAIL");
});

// 11. flat/no-signal example
test("flat/no-signal example", () => {
  assert.strictEqual(monoDirection([1, 2, 1, 2]), "MIXED");
});

// 12. PASS blocked below n=100
test("PASS blocked below n=100", () => {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push(
      mkRecord({
        candidateId: "p" + i,
        mint: "P" + i,
        deployer: "D" + i,
        convictionScore: i,
        convictionWindowN: 150,
        outcome: {
          realizedPnl: i,
          execMfe: i,
          execMae: -5,
          win: i > 0,
          complete: true,
          status: "complete",
        },
      })
    );
  }
  const f = filterEffective(rows, { universe: "live_selected" });
  const cohorts = buildCohorts(f.effective);
  const mono = monotonicityReport(cohorts);
  const corr = correlations(f.effective);
  const v = evaluatePromotion({
    effective: f.effective,
    deployerN: 50,
    cohortBundle: cohorts,
    mono,
    corr,
  });
  assert.notStrictEqual(v.status, STATUS.PASS);
  assert.ok(v.status === STATUS.DIAGNOSTIC || v.status === STATUS.COLLECT);
});

// 13. DIAGNOSTIC allowed at n>=30
test("DIAGNOSTIC allowed at n>=30", () => {
  const rows = [];
  for (let i = 0; i < 35; i++) {
    rows.push(
      mkRecord({
        candidateId: "d" + i,
        mint: "D" + i,
        deployer: "Dep" + i,
        convictionScore: i,
        convictionWindowN: 120,
        outcome: {
          realizedPnl: i - 10,
          execMfe: i - 5,
          execMae: -20,
          win: i > 10,
          complete: true,
          status: "complete",
        },
      })
    );
  }
  const f = filterEffective(rows, { universe: "live_selected" });
  assert.ok(f.effective_n >= DIAGNOSTIC_N);
  const cohorts = buildCohorts(f.effective);
  const mono = monotonicityReport(cohorts);
  const corr = correlations(f.effective);
  const v = evaluatePromotion({
    effective: f.effective,
    deployerN: f.effective_n,
    cohortBundle: cohorts,
    mono,
    corr,
  });
  assert.strictEqual(v.status, STATUS.DIAGNOSTIC);
});

// 14. PASS evaluation at n>=100 (synthetic monotonic)
test("PASS evaluation at n>=100", () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const score = i;
    const pnl = (i / 120) * 40 - 5; // mostly increasing with score
    rows.push(
      mkRecord({
        candidateId: "z" + i,
        mint: "Z" + i,
        deployer: "DZ" + i,
        convictionScore: score,
        convictionWindowN: 200,
        outcome: {
          realizedPnl: pnl,
          execMfe: pnl + 5,
          execMae: -10 + i * 0.05,
          win: pnl > 0,
          complete: true,
          status: "complete",
          stopLoss: false,
          maxHold: true,
          exitReason: "MAX_HOLD",
        },
      })
    );
  }
  const f = filterEffective(rows, { universe: "live_selected" });
  assert.ok(f.effective_n >= PROMOTION_N);
  const cohorts = buildCohorts(f.effective);
  const mono = monotonicityReport(cohorts);
  const corr = correlations(f.effective);
  const v = evaluatePromotion({
    effective: f.effective,
    deployerN: f.effective_n,
    cohortBundle: cohorts,
    mono,
    corr,
  });
  // Synthetic data should PASS or at least not COLLECT
  assert.ok(v.status === STATUS.PASS || v.status === STATUS.FAIL);
  assert.notStrictEqual(v.status, STATUS.COLLECT);
  assert.notStrictEqual(v.status, STATUS.DIAGNOSTIC);
});

// 15. leakage invalidates promotion
test("leakage invalidates promotion", () => {
  const rows = [];
  for (let i = 0; i < 110; i++) {
    rows.push(
      mkRecord({
        candidateId: "L" + i,
        mint: "L" + i,
        deployer: "DL" + i,
        convictionScore: i,
        convictionWindowN: 200,
        leakageReasons: i === 0 ? ["explicit_leak_flag"] : [],
        outcome: {
          realizedPnl: i,
          execMfe: i,
          execMae: -5,
          win: true,
          complete: true,
          status: "complete",
        },
      })
    );
  }
  // Put leak on an effective row after filter — inject into evaluate directly
  const f = filterEffective(rows.filter((r) => !r.leakageReasons.length), {
    universe: "live_selected",
  });
  f.effective[0].leakageReasons = ["explicit_leak_flag"];
  const cohorts = buildCohorts(f.effective);
  const mono = monotonicityReport(cohorts);
  const corr = correlations(f.effective);
  const v = evaluatePromotion({
    effective: f.effective,
    deployerN: f.effective_n,
    cohortBundle: cohorts,
    mono,
    corr,
  });
  assert.strictEqual(v.status, STATUS.INVALID);
});

// 16. MFE sign/math
test("MFE sign/math", () => {
  // Path: +24, +19, -5.8, +25.9 → peak must be +25.9
  const { execMfe, execMae, valid } = execPathPeaks([24, 19.3, -5.8, 25.9, 24.1]);
  assert.strictEqual(valid, true);
  assert.strictEqual(execMfe, 25.9);
  assert.strictEqual(execMae, -5.8);
});

// 17. MAE sign/math
test("MAE sign/math", () => {
  const { execMae } = execPathPeaks([0, -10, -26.1, -5]);
  assert.strictEqual(execMae, -26.1);
  // Never treat missing as zero
  const bad = execPathPeaks([]);
  assert.strictEqual(bad.execMfe, null);
  assert.strictEqual(bad.valid, false);
});

// 18. deterministic bootstrap seed
test("deterministic bootstrap seed", () => {
  const a = [1, 2, 3, 4, 5, 10];
  const b = [-5, -4, -3, -2, -1, 0];
  const x = bootstrapMedianDiff(a, b, { seed: 42, nBoot: 200 });
  const y = bootstrapMedianDiff(a, b, { seed: 42, nBoot: 200 });
  assert.strictEqual(x.diff, y.diff);
  assert.strictEqual(x.lo, y.lo);
  assert.strictEqual(x.hi, y.hi);
  const rnd1 = mulberry32(7);
  const rnd2 = mulberry32(7);
  assert.strictEqual(rnd1(), rnd2());
});

// 19. rank correlation math
test("rank correlation math", () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [2, 4, 6, 8, 10];
  const sp = spearman(xs, ys);
  assert.ok(Math.abs(sp.rho - 1) < 1e-9);
  const kt = kendallTau(xs, ys);
  assert.ok(Math.abs(kt.tau - 1) < 1e-9);
  const neg = spearman(xs, [10, 8, 6, 4, 2]);
  assert.ok(Math.abs(neg.rho - -1) < 1e-9);
});

// 20. machine-readable report schema
test("machine-readable report schema", () => {
  const { run } = require("./report");
  // empty paths → empty report still schema-valid
  const tmpD = path.join(__dirname, "_tmp_dec.jsonl");
  const tmpE = path.join(__dirname, "_tmp_ex.jsonl");
  fs.writeFileSync(tmpD, "");
  fs.writeFileSync(tmpE, "");
  const report = run({ decisions: tmpD, exits: tmpE, epoch: RESEARCH_EPOCH });
  fs.unlinkSync(tmpD);
  fs.unlinkSync(tmpE);
  assert.ok(report.research_epoch);
  assert.ok(typeof report.raw_n === "number");
  assert.ok(typeof report.effective_n === "number");
  assert.ok(report.exclusions);
  assert.ok(report.requirements);
  assert.ok(report.promotion);
  assert.ok(report.status);
  assert.strictEqual(report.measurement_only, true);
  assert.strictEqual(report.live_economics_unchanged, true);
  assert.strictEqual(report.status, STATUS.COLLECT);
});

// research identity stability
test("research identity stable", () => {
  const id = researchIdentity({ mint: "M", createSig: "S", decision: "buy", ts: 1 });
  assert.strictEqual(id, "M|S|buy|1");
});

// detectLeakage
test("detectLeakage flags", () => {
  const reasons = detectLeakage({ lookahead: true });
  assert.ok(reasons.includes("explicit_leak_flag"));
});

// shadow universe never mixes into live_selected
test("shadow universe separate from live_selected", () => {
  const rows = [
    mkRecord({
      candidateId: "live1",
      mint: "L1",
      selected: true,
      sampleKind: "live_selected",
      outcome: {
        status: "complete",
        complete: true,
        realizedPnl: -20,
        execMfe: -10,
        execMae: -25,
      },
    }),
    mkRecord({
      candidateId: "sh1",
      mint: "S1",
      selected: false,
      sampleKind: "shadow",
      shadowSample: true,
      skipCohort: "kill_gated",
      selectionReason: "kill 7d avgExecPnl=-30%",
      outcome: {
        status: "complete",
        complete: true,
        realizedPnl: 5,
        execMfe: 12,
        execMae: -8,
      },
    }),
    mkRecord({
      candidateId: "stale1",
      mint: "ST1",
      selected: false,
      sampleKind: "shadow",
      shadowSample: true,
      skipCohort: "stale_create",
      selectionReason: "stale create 1200ms",
      outcome: {
        status: "complete",
        complete: true,
        realizedPnl: 40,
        execMfe: 50,
        execMae: -5,
      },
    }),
  ];
  const live = filterEffective(rows, { universe: "live_selected" });
  const shadow = filterEffective(rows, { universe: "shadow" });
  const shadowEx = filterEffective(rows, {
    universe: "shadow",
    excludeStaleShadow: true,
  });
  assert.strictEqual(live.effective_n, 1);
  assert.strictEqual(shadow.effective_n, 2);
  assert.strictEqual(shadowEx.effective_n, 1);
  assert.ok(shadowEx.exclusions.stale_shadow_cohort >= 1);
});

console.log("");
console.log(`results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
