/**
 * Frozen promotion protocol — measurement-only research policy.
 * DO NOT weaken thresholds after seeing results.
 *
 * Ordering (higher-is-better metrics):
 *   baseline < top5 < top2 ≤ top1
 * MAE (lower-is-better / less-negative-is-better): must not materially worsen.
 */

"use strict";

/** Research epoch for post-correctness-fix collection */
const RESEARCH_EPOCH = "post_fix_v1";

const MODEL_VERSION = "deployer85-shrink-v1";
const FEATURE_VERSION = "decision-time-v1";
const STATE_FIX_VERSION = "2026-10-04-mfe-stale-cdf";
const PERCENTILE_WINDOW_VERSION = "empirical-cdf-v1";

/** Empirical CDF denominator before top-N cohorts are interpretable */
const MIN_CONV_WINDOW_N = 100;

/** Stage thresholds (independent deployers with complete labels) */
const DIAGNOSTIC_N = 30;
const PROMOTION_N = 100;

/** MAE slack (percentage points) for "not materially worse" */
const MAE_SLACK_PP = 5;

const STATUS = {
  COLLECT: "COLLECT",
  DIAGNOSTIC: "DIAGNOSTIC",
  PASS: "PASS",
  FAIL: "FAIL",
  INVALID: "PROMOTION_INVALID",
};

const FAIL_REASONS = {
  NO_RANK_SIGNAL: "NO_RANK_SIGNAL",
  REVERSED_RANK_SIGNAL: "REVERSED_RANK_SIGNAL",
  INSUFFICIENT_SAMPLE: "INSUFFICIENT_SAMPLE",
  INSUFFICIENT_COHORT_DEPTH: "INSUFFICIENT_COHORT_DEPTH",
  HIGH_VARIANCE: "HIGH_VARIANCE",
  MODEL_DRIFT: "MODEL_DRIFT",
  MISSING_FEATURE_DATA: "MISSING_FEATURE_DATA",
  OUTCOME_LABEL_QUALITY: "OUTCOME_LABEL_QUALITY",
  LEAKAGE: "LEAKAGE",
};

const OUTCOME_STATUS = {
  COMPLETE: "complete",
  CENSORED: "censored",
  MISSING: "missing",
  INVALID: "invalid",
};

module.exports = {
  RESEARCH_EPOCH,
  MODEL_VERSION,
  FEATURE_VERSION,
  STATE_FIX_VERSION,
  PERCENTILE_WINDOW_VERSION,
  MIN_CONV_WINDOW_N,
  DIAGNOSTIC_N,
  PROMOTION_N,
  MAE_SLACK_PP,
  STATUS,
  FAIL_REASONS,
  OUTCOME_STATUS,
};
