/**
 * Hypothetical priority-fee estimate. Research cost only.
 *
 * The Chainstack live plugin
 *   blablablasealsaresoft/chainstack-pumpfun-bonkfun-bot
 *     src/core/priority_fee/dynamic_fee.py
 * uses a high percentile (about the 70th) so live sends land faster.
 * This research estimator uses the median and never submits a transaction.
 *
 * Jupiter priority-fee repo is the reference for reading
 * getRecentPrioritizationFees and separating quote cost from send.
 */
"use strict";

function median(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid];
  return (xs[mid - 1] + xs[mid]) / 2;
}

function medianPriorityFeeMicroLamports(fees) {
  return median(fees);
}

/**
 * All-in cost in basis points of a notional entry, from already-fetched inputs.
 * Does not call RPC and does not escalate fees.
 */
function estimatedAllInCostBps(input) {
  const notionalLamports = input.notionalLamports;
  if (!notionalLamports) return null;
  const micro = medianPriorityFeeMicroLamports(input.recentPriorityFees || []);
  const cu = input.estimatedCu || 0;
  const priorityLamports = micro == null ? 0 : (micro * cu) / 1_000_000;
  const rent = input.ataRentLamports || 0;
  const routeFee = input.routeFeeLamports || 0;
  const poolFee = input.poolFeeLamports || 0;
  const impactBps = input.priceImpactBps || 0;
  const fixed = priorityLamports + rent + routeFee + poolFee;
  return (fixed / notionalLamports) * 10_000 + impactBps;
}

module.exports = {
  median,
  medianPriorityFeeMicroLamports,
  estimatedAllInCostBps,
};
