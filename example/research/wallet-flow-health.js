#!/usr/bin/env node
/**
 * Wallet-flow collection health. Research only.
 *   npm run research:wallet-flow-health
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { defaultPaths, loadJsonl } = require("./records");
const flow = require("./wallet-flow-v1");

function bookFromFile(file) {
  const book = flow.emptyBook();
  if (!file || !fs.existsSync(file)) return book;
  for (const row of loadJsonl(file)) flow.ingestRecord(book, row);
  return book;
}

function pct(x) {
  return typeof x === "number" && Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a";
}

function formatHealth(h) {
  const q = h.flowAmountQuality || {};
  const w = h.walletResolution || {};
  const s = h.sourceCoverage || {};
  const lines = [
    "WALLET FLOW HEALTH",
    "epoch: " + h.epoch,
    "feature version: " + h.featureVersion,
    "collector fix: " + h.collectorFixVersion,
    "prior feature version excluded: " + h.priorFeatureVersion,
    "corrected boundary ms: " + (h.correctedBoundaryAt == null ? "n/a" : h.correctedBoundaryAt),
    "prior epoch left unchanged: " + h.priorEpochUnchanged,
    "launches observed: " + h.launches,
    "pre-fix launches excluded: " + h.preFixExcludedLaunches,
    "pre-fix events excluded: " + h.preFixExcludedEvents,
    "flow tx observed: " + h.flowTxObserved,
    "deduped transactions: " + h.dedupedTransactions,
    "source merges: " + h.sourceMerges,
    "wallet resolved rate: " + pct(h.walletResolvedRate),
    "amount resolved rate: " + pct(h.amountResolvedRate),
    "100ms independent launches: " + h.w100.launchesWithIndependentFlow + " decision-eligible: " + h.w100.decisionEligible + " coverage: " + pct(h.w100.independentFlowCoverage) + " unique values: " + h.w100.uniqueValueCount,
    "250ms independent launches: " + h.w250.launchesWithIndependentFlow + " decision-eligible: " + h.w250.decisionEligible + " coverage: " + pct(h.w250.independentFlowCoverage) + " unique values: " + h.w250.uniqueValueCount,
    "500ms independent launches: " + h.w500.launchesWithIndependentFlow + " decision-eligible: " + h.w500.decisionEligible + " coverage: " + pct(h.w500.independentFlowCoverage) + " unique values: " + h.w500.uniqueValueCount,
    "100ms amount launches gross/net/top/creator: " + h.w100.grossBuySol + "/" + h.w100.netBuySol + "/" + h.w100.topBuyerShare + "/" + h.w100.creatorShareOfBuyFlow,
    "250ms amount launches gross/net/top/creator: " + h.w250.grossBuySol + "/" + h.w250.netBuySol + "/" + h.w250.topBuyerShare + "/" + h.w250.creatorShareOfBuyFlow,
    "500ms amount launches gross/net/top/creator: " + h.w500.grossBuySol + "/" + h.w500.netBuySol + "/" + h.w500.topBuyerShare + "/" + h.w500.creatorShareOfBuyFlow,
    "source helius_preprocessed: " + (s.helius_preprocessed || 0),
    "source helius_processed: " + (s.helius_processed || 0),
    "source geyser: " + (s.geyser || 0),
    "source logs: " + (s.logs || 0),
    "source overlap: " + h.sourceOverlap,
    "flow_amount_quality events_total=" + q.events_total + " quote_raw_present=" + q.quote_raw_present + " quote_amount_resolved=" + q.quote_amount_resolved + " sol_amount_resolved=" + q.sol_amount_resolved + " custom_quote_raw_present=" + q.custom_quote_raw_present + " unknown_amount=" + q.unknown_amount,
    "wallet_resolution flow_buys=" + w.flow_buys + " wallet_present=" + w.wallet_present + " wallet_missing=" + w.wallet_missing + " creator_wallet=" + w.creator_wallet + " deployer_wallet=" + w.deployer_wallet + " non_creator_wallet=" + w.non_creator_wallet,
    "creator-only flow count: " + h.creatorOnlyFlow,
    "non-creator flow count: " + h.nonCreatorFlow,
    "wallet-history coverage: " + h.walletHistoryCoverage,
    "late-only flow count: " + h.lateOnlyFlow,
    "leakage violations: " + h.leakageViolations,
    "pre-fix 6.1% early-flow estimate is not the corrected sample",
  ];
  return lines.join("\n");
}

function main() {
  const paths = defaultPaths();
  const file = path.join(path.dirname(paths.decisionPath), "v3-wallet-flow.jsonl");
  const book = bookFromFile(file);
  const health = flow.healthFromBook(book);
  const text = formatHealth(health);
  if (/ENABLE LIVE|PROMOTE LIVE|TURN OFF KILL/.test(text)) throw new Error("forbidden live recommendation");
  console.log(text);
  console.log("wrote research-only wallet-flow health");
}

if (require.main === module) main();

module.exports = { bookFromFile, formatHealth };
