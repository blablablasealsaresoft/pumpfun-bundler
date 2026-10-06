/**
 * Canonical launch observation. Research only.
 *
 * Adapted from:
 *   blablablasealsaresoft/chainstack-pumpfun-bonkfun-bot
 *     src/platforms/pumpfun/event_parser.py
 *       _CREATE_V2_QUOTE_MINT_ACCOUNT_INDEX = 16
 *       CreateEvent quote_mint / is_mayhem_mode / is_cashback_enabled
 *     src/platforms/letsbonk/event_parser.py
 *       Platform.LETS_BONK, initialize / initialize_v2 / initialize_with_token_2022
 *   blablablasealsaresoft/chainstack-pumpfun-cli
 *     src/pumpfun_cli/protocol/pumpswap.py parse_pool_data quote_mint
 *
 * Does not submit transactions.
 */
"use strict";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** 0-based index of the optional create_v2 quote-mint remaining account. */
const CREATE_V2_QUOTE_MINT_ACCOUNT_INDEX = 16;

const LETS_BONK_INIT_INSTRUCTIONS = new Set([
  "initialize",
  "initialize_v2",
  "initialize_with_token_2022",
]);

function emptyObservation(partial = {}) {
  return {
    mint: partial.mint || null,
    platform: partial.platform || "unknown",
    createSignature: partial.createSignature || partial.createSig || null,
    firstObservedAt: partial.firstObservedAt ?? partial.observedAt ?? null,
    decisionCutoffAt: partial.decisionCutoffAt ?? null,
    chainSlot: partial.chainSlot ?? partial.slot ?? null,
    sources: Array.isArray(partial.sources) ? partial.sources.slice() : [],
    creator: partial.creator ?? null,
    creatorSource: partial.creatorSource ?? null,
    deployer: partial.deployer ?? null,
    quoteMint: partial.quoteMint ?? null,
    quoteMintSource: partial.quoteMintSource ?? null,
    quoteDecimals: partial.quoteDecimals ?? null,
    quoteAssetClass: partial.quoteAssetClass || "UNKNOWN",
    isCustomPair: partial.isCustomPair === true,
    createVersion: partial.createVersion || "unknown",
    mayhem: partial.mayhem ?? null,
    cashback: partial.cashback ?? null,
    bondingCurve: partial.bondingCurve ?? null,
    conflicts: Array.isArray(partial.conflicts) ? partial.conflicts.slice() : [],
    rawEventFields: partial.rawEventFields ? { ...partial.rawEventFields } : {},
    researchEpoch: partial.researchEpoch || null,
  };
}

/**
 * Quote mint from create_v2 remaining accounts.
 * Absent index means native SOL quote, not a fabricated custom mint.
 */
function quoteFromCreateV2Accounts(accountKeys, opts = {}) {
  const isCreateV2 = opts.isCreateV2 === true || opts.createVersion === "create_v2";
  if (!isCreateV2) {
    return { quoteMint: null, quoteMintSource: null, createVersion: opts.createVersion || "legacy" };
  }
  const keys = accountKeys || [];
  const mint = keys[CREATE_V2_QUOTE_MINT_ACCOUNT_INDEX] || null;
  if (!mint) {
    return {
      quoteMint: SOL_MINT,
      quoteMintSource: "create_v2_native_default",
      createVersion: "create_v2",
    };
  }
  return {
    quoteMint: mint,
    quoteMintSource: "create_v2_remaining_account",
    createVersion: "create_v2",
  };
}

function classifyQuote(input, registry = {}) {
  const explicit = input && input.quoteAssetClass;
  if (
    explicit &&
    ["SOL", "USDC", "TOKENIZED_ASSET", "CUSTOM", "UNKNOWN"].includes(explicit) &&
    input.quoteMint
  ) {
    return {
      quoteMint: input.quoteMint,
      quoteAssetClass: explicit,
      isCustomPair: explicit === "CUSTOM" || explicit === "TOKENIZED_ASSET",
      quoteDecimals: input.quoteDecimals ?? null,
    };
  }
  const mint = input && (input.quoteMint || input.mint);
  if (!mint) {
    return { quoteMint: null, quoteAssetClass: "UNKNOWN", isCustomPair: false, quoteDecimals: null };
  }
  if (mint === SOL_MINT) {
    return { quoteMint: mint, quoteAssetClass: "SOL", isCustomPair: false, quoteDecimals: 9 };
  }
  if (mint === USDC_MINT) {
    return { quoteMint: mint, quoteAssetClass: "USDC", isCustomPair: true, quoteDecimals: 6 };
  }
  if (registry && registry[mint]) {
    const cls = registry[mint];
    return {
      quoteMint: mint,
      quoteAssetClass: cls,
      isCustomPair: cls !== "SOL",
      quoteDecimals: input.quoteDecimals ?? null,
    };
  }
  return {
    quoteMint: mint,
    quoteAssetClass: "CUSTOM",
    isCustomPair: true,
    quoteDecimals: input.quoteDecimals ?? null,
  };
}

function classifyPlatform(input = {}) {
  if (input.platform === "pump_fun" || input.platform === "lets_bonk") return input.platform;
  const name = String(input.instructionName || input.instruction || "");
  if (LETS_BONK_INIT_INSTRUCTIONS.has(name) || input.programLabel === "lets_bonk") return "lets_bonk";
  if (input.createVersion === "create_v2" || input.createVersion === "legacy" || input.platformHint === "pump") {
    return "pump_fun";
  }
  return "unknown";
}

function classifyCreateVersion(input = {}) {
  if (input.createVersion === "create_v2" || input.instruction === "Create_v2" || input.isCreateV2 === true) {
    return "create_v2";
  }
  if (input.createVersion === "legacy" || input.instruction === "Create") return "legacy";
  return "unknown";
}

function cutoffAllows(observedAt, decisionCutoffAt) {
  if (typeof observedAt !== "number" || typeof decisionCutoffAt !== "number") return false;
  return observedAt <= decisionCutoffAt;
}

/**
 * Wallet-flow measurements after the cutoff are descriptive only.
 */
function splitWalletFlow(flow, decisionCutoffAt) {
  const decision = {};
  const descriptive = {};
  const excluded = [];
  if (!flow) return { decision, descriptive, excluded };
  for (const [key, value] of Object.entries(flow)) {
    if (value == null || typeof value !== "object" || typeof value.observedAt !== "number") {
      excluded.push(key);
      continue;
    }
    if (cutoffAllows(value.observedAt, decisionCutoffAt)) decision[key] = value.value;
    else {
      descriptive[key] = value.value;
      excluded.push(key);
    }
  }
  return { decision, descriptive, excluded };
}

function sameField(a, b) {
  return a == null || b == null || a === b;
}

/**
 * Reconcile feed observations for one mint. Conflicts are kept, not overwritten.
 */
function reconcileObservations(events) {
  if (!events || !events.length) return null;
  const sorted = [...events].sort(
    (a, b) => (a.observedAt || 0) - (b.observedAt || 0) || String(a.source).localeCompare(String(b.source))
  );
  const first = sorted[0];
  const sources = sorted.map((e) => ({
    source: e.source || "other",
    observedAt: e.observedAt ?? null,
    slot: e.slot ?? null,
  }));
  const slots = sources.map((s) => s.slot).filter((s) => typeof s === "number");
  const uniqueSlots = new Set(slots);
  const pre = sources.find((s) => s.source === "helius_preprocessed");
  const processed = sources.find((s) => s.source === "helius_processed");
  const conflicts = [];
  const creators = new Set(sorted.map((e) => e.creator).filter(Boolean));
  if (creators.size > 1) conflicts.push({ field: "creator", values: [...creators] });
  const quotes = new Set(sorted.map((e) => e.quoteMint).filter(Boolean));
  if (quotes.size > 1) conflicts.push({ field: "quoteMint", values: [...quotes] });

  const quote = classifyQuote({
    quoteMint: first.quoteMint || null,
    quoteAssetClass: first.quoteAssetClass,
    quoteDecimals: first.quoteDecimals,
  });
  const createVersion = classifyCreateVersion(first);
  const platform = classifyPlatform({ ...first, createVersion });

  const obs = emptyObservation({
    mint: first.mint,
    platform,
    createSignature: first.createSignature || first.signature || null,
    firstObservedAt: first.observedAt ?? null,
    decisionCutoffAt: first.decisionCutoffAt ?? first.observedAt ?? null,
    chainSlot: first.slot ?? null,
    sources,
    creator: creators.size === 1 ? [...creators][0] : first.creator || null,
    creatorSource: first.creatorSource || (first.creator ? "create_event" : null),
    deployer: first.deployer || first.creator || null,
    quoteMint: quote.quoteMint,
    quoteMintSource: first.quoteMintSource || null,
    quoteDecimals: quote.quoteDecimals,
    quoteAssetClass: quote.quoteAssetClass,
    isCustomPair: quote.isCustomPair,
    createVersion,
    mayhem: first.mayhem ?? first.isMayhemMode ?? null,
    cashback: first.cashback ?? first.isCashbackCoin ?? null,
    bondingCurve: first.bondingCurve || null,
    conflicts,
    rawEventFields: first.rawEventFields || {},
    researchEpoch: first.researchEpoch || null,
  });
  obs.firstSource = sources[0] ? sources[0].source : null;
  obs.secondSource = sources[1] ? sources[1].source : null;
  obs.sourceCount = sources.length;
  obs.sourceAgreement = conflicts.length === 0 && sources.length > 0;
  obs.preToProcessedMs =
    pre && processed && typeof pre.observedAt === "number" && typeof processed.observedAt === "number"
      ? processed.observedAt - pre.observedAt
      : null;
  obs.firstSlot = slots.length ? slots[0] : null;
  obs.confirmedSlot = processed ? processed.slot : null;
  obs.slotDisagreement = uniqueSlots.size > 1;
  return obs;
}

function isMayhemRegime(row) {
  return row.mayhem === true || row.regimeLabel === "mayhem";
}

module.exports = {
  SOL_MINT,
  USDC_MINT,
  CREATE_V2_QUOTE_MINT_ACCOUNT_INDEX,
  LETS_BONK_INIT_INSTRUCTIONS,
  emptyObservation,
  quoteFromCreateV2Accounts,
  classifyQuote,
  classifyPlatform,
  classifyCreateVersion,
  cutoffAllows,
  splitWalletFlow,
  sameField,
  reconcileObservations,
  isMayhemRegime,
};
