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
  for (const row of loadJsonl(file)) {
    if (row.type === "wallet_flow_launch") {
      flow.noteCandidate(book, row);
      const launch = book.launches.get(row.mint);
      if (!launch) continue;
      if (launch.decisionCutoffAt == null && row.decisionCutoffAt != null) launch.decisionCutoffAt = row.decisionCutoffAt;
      if (row.firstObservedAt != null) launch.firstObservedAt = Math.min(launch.firstObservedAt || row.firstObservedAt, row.firstObservedAt);
      launch.creator = launch.creator || row.creator;
      launch.deployer = launch.deployer || row.deployer;
      launch.quoteMint = launch.quoteMint || row.quoteMint;
      launch.mayhem = launch.mayhem || row.mayhem === true;
      launch.sourceCountAtDecision = row.sourceCountAtDecision != null ? row.sourceCountAtDecision : launch.sourceCountAtDecision;
      launch.deployerEvidenceN = row.deployerEvidenceN != null ? row.deployerEvidenceN : launch.deployerEvidenceN;
      launch.pnl = row.pnl != null ? row.pnl : launch.pnl;
      launch.mfe = row.mfe != null ? row.mfe : launch.mfe;
      launch.mae = row.mae != null ? row.mae : launch.mae;
      launch.outcomeObservedAt = row.outcomeObservedAt != null ? row.outcomeObservedAt : launch.outcomeObservedAt;
    } else if (row.type === "wallet_flow_event") {
      flow.observeFlow(book, row);
    } else if (row.type === "wallet_flow_source") {
      book.rawObservations = (book.rawObservations || 0) + 1;
    } else if (row.type === "wallet_flow_outcome") {
      const launch = book.launches.get(row.mint);
      if (!launch) continue;
      launch.pnl = row.pnl;
      launch.mfe = row.mfe;
      launch.mae = row.mae;
      launch.runner10 = row.runner10;
      launch.outcomeObservedAt = row.outcomeObservedAt;
    }
  }
  return book;
}

function formatHealth(h) {
  const lines = [
    "WALLET FLOW HEALTH",
    "epoch: " + h.epoch,
    "feature version: " + h.featureVersion,
    "prior epoch left unchanged: " + h.priorEpochUnchanged,
    "launches observed: " + h.launches,
    "flow tx observed: " + h.flowTxObserved,
    "deduped transactions: " + h.dedupedTransactions,
    "100ms launches with independent flow: " + h.w100.launchesWithIndependentFlow + " decision-eligible: " + h.w100.decisionEligible + " unique values: " + h.w100.uniqueValueCount,
    "250ms launches with independent flow: " + h.w250.launchesWithIndependentFlow + " decision-eligible: " + h.w250.decisionEligible + " unique values: " + h.w250.uniqueValueCount,
    "500ms launches with independent flow: " + h.w500.launchesWithIndependentFlow + " decision-eligible: " + h.w500.decisionEligible + " unique values: " + h.w500.uniqueValueCount,
    "creator-only flow count: " + h.creatorOnlyFlow,
    "non-creator flow count: " + h.nonCreatorFlow,
    "wallet-history coverage: " + h.walletHistoryCoverage,
    "late-only flow count: " + h.lateOnlyFlow,
    "leakage violations: " + h.leakageViolations,
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
