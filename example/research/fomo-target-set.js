/**
 * Frozen Fomo claimed-wallet target set. Research only.
 *
 * externalTargetSetVersion = fomoscan_wallets_2026_09_16_v1
 * externalTargetSnapshotAt = 2026-09-16T21:50:00Z
 *
 * These are activity tiers, not profitability tiers.
 * fomoClaimedWallet is a claim. It is not proof of handle control.
 * chainObservedFomoWallet is address-level only. Do not infer from trader totals.
 * This module cannot promote live or change a live gate.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const EXTERNAL_TARGET_SET_VERSION = "fomoscan_wallets_2026_09_16_v1";
const EXTERNAL_TARGET_SNAPSHOT_AT = "2026-09-16T21:50:00Z";
const EXTERNAL_TARGET_SNAPSHOT_MS = Date.parse(EXTERNAL_TARGET_SNAPSHOT_AT);

const EXPECTED = {
  solanaTotal: 355,
  f1: 144,
  f2: 52,
  f3: 46,
  f4: 20,
  f5: 9,
  observedSwaps: 20619,
};

function defaultCsvPath() {
  return path.join(__dirname, "targets", "fomoscan_wallets_2026_09_16_v1.csv");
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cols[j] == null ? "" : cols[j];
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function tierOf(swaps, tokens) {
  if (swaps >= 500 && tokens >= 100) return 5;
  if (swaps >= 250 && tokens >= 50) return 4;
  if (swaps >= 100 && tokens >= 25) return 3;
  if (swaps >= 100) return 2;
  if (swaps >= 1) return 1;
  return 0;
}

function loadTargetSet(csvPath) {
  const file = csvPath || defaultCsvPath();
  if (!fs.existsSync(file)) {
    return {
      version: EXTERNAL_TARGET_SET_VERSION,
      snapshotAt: EXTERNAL_TARGET_SNAPSHOT_AT,
      snapshotMs: EXTERNAL_TARGET_SNAPSHOT_MS,
      path: file,
      loaded: false,
      byAddress: new Map(),
      counts: null,
      error: "missing_target_csv",
    };
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const byAddress = new Map();
  let observedSwaps = 0;
  const counts = { f0: 0, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0 };
  for (const row of rows) {
    if (String(row.chain || "").toLowerCase() !== "solana") continue;
    const address = String(row.address || "").trim();
    if (!address) continue;
    const swaps = Number(row.chain_observed_swaps || 0);
    const tokens = Number(row.chain_distinct_tokens || 0);
    const tier = tierOf(swaps, tokens);
    const entry = {
      traderId: String(row.trader_id || ""),
      handle: String(row.handle || ""),
      address,
      chain: "solana",
      verificationStatus: String(row.verification_status || ""),
      sources: String(row.sources || ""),
      fomoClaimedWallet: true,
      chainObservedFomoWallet: swaps >= 1,
      activityTier: {
        F0: true,
        F1: swaps >= 1,
        F2: swaps >= 100,
        F3: swaps >= 100 && tokens >= 25,
        F4: swaps >= 250 && tokens >= 50,
        F5: swaps >= 500 && tokens >= 100,
      },
      maxTier: tier,
      priorObservedSwapCount: swaps,
      priorDistinctTokenCount: tokens,
      priorObservedVolumeUsd: row.chain_volume_usd === "" ? null : Number(row.chain_volume_usd),
      priorFirstObserved: row.chain_first_observed || null,
      priorLastObserved: row.chain_last_observed || null,
    };
    byAddress.set(address, entry);
    counts.f0 += 1;
    if (entry.activityTier.F1) counts.f1 += 1;
    if (entry.activityTier.F2) counts.f2 += 1;
    if (entry.activityTier.F3) counts.f3 += 1;
    if (entry.activityTier.F4) counts.f4 += 1;
    if (entry.activityTier.F5) counts.f5 += 1;
    if (swaps > 0) observedSwaps += swaps;
  }
  const ok =
    counts.f0 === EXPECTED.solanaTotal &&
    counts.f1 === EXPECTED.f1 &&
    counts.f2 === EXPECTED.f2 &&
    counts.f3 === EXPECTED.f3 &&
    counts.f4 === EXPECTED.f4 &&
    counts.f5 === EXPECTED.f5 &&
    observedSwaps === EXPECTED.observedSwaps;
  return {
    version: EXTERNAL_TARGET_SET_VERSION,
    snapshotAt: EXTERNAL_TARGET_SNAPSHOT_AT,
    snapshotMs: EXTERNAL_TARGET_SNAPSHOT_MS,
    path: file,
    loaded: true,
    byAddress,
    counts,
    observedSwaps,
    matchesExpected: ok,
    error: ok ? null : "universe_count_mismatch",
  };
}

function externalTargetFeatureEligible(launchObservedAt, targetSet) {
  if (!targetSet || !targetSet.loaded || !targetSet.matchesExpected) return false;
  if (!Number.isFinite(launchObservedAt)) return false;
  return launchObservedAt > targetSet.snapshotMs;
}

function lookupAddress(targetSet, address) {
  if (!targetSet || !targetSet.byAddress || !address) return null;
  return targetSet.byAddress.get(address) || null;
}

module.exports = {
  EXTERNAL_TARGET_SET_VERSION,
  EXTERNAL_TARGET_SNAPSHOT_AT,
  EXTERNAL_TARGET_SNAPSHOT_MS,
  EXPECTED,
  defaultCsvPath,
  loadTargetSet,
  externalTargetFeatureEligible,
  lookupAddress,
  tierOf,
};
