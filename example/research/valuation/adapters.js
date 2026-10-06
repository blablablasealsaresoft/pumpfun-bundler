/**
 * Shadow valuation adapters. Quote and simulation only.
 *
 * References (math and pool fields, not send paths):
 *   blablablasealsaresoft/chainstack-pumpfun-cli
 *     src/pumpfun_cli/protocol/curve.py
 *     src/pumpfun_cli/protocol/pumpswap.py  (reserve price = quote/base)
 *   blablablasealsaresoft/chainstack-raydium-sdk-swap-example-typescript
 *     src/RaydiumSwap.ts computeAmountOut / simulateTransaction
 *   blablablasealsaresoft/chainstack-jupiter-swaps-priority-fees-python
 *     quote output and priority-fee estimate, never the send portion
 *
 * broadcast is impossible on every adapter.
 */
"use strict";

const curve = require("./curve");

function broadcastBlocked(adapter) {
  return function broadcast() {
    throw new Error(adapter + " broadcast is disabled");
  };
}

function cpmmOut(reserveIn, reserveOut, amountIn, feeBps) {
  const fee = feeBps == null ? 0 : feeBps;
  const amount = Math.floor(amountIn);
  const rin = Math.floor(reserveIn);
  const rout = Math.floor(reserveOut);
  if (amount <= 0 || rin <= 0 || rout <= 0) return 0;
  const kept = amount * (10_000 - fee);
  return Math.floor((rout * kept) / (rin * 10_000 + kept));
}

function pumpCurveAdapter() {
  return {
    name: "pump_curve",
    supports(state) {
      return !!(state && state.virtualSolReserves != null && state.virtualTokenReserves != null && !state.complete);
    },
    quoteEntry(state, solLamports) {
      return {
        amountOut: curve.calculateBuyTokensOut(state, solLamports),
        price: curve.getTokenPriceSol(state),
        source: "pump_curve",
      };
    },
    quoteExit(state, tokenAmount) {
      return {
        amountOut: curve.calculateSellSolOut(state, tokenAmount),
        source: "pump_curve",
      };
    },
    broadcast: broadcastBlocked("pump_curve"),
  };
}

function pumpSwapAdapter(feeBps = 0) {
  return {
    name: "pumpswap",
    supports(state) {
      return !!(state && state.baseReserve != null && state.quoteReserve != null);
    },
    quoteEntry(state, quoteIn) {
      return {
        amountOut: cpmmOut(state.quoteReserve, state.baseReserve, quoteIn, feeBps),
        price: state.baseReserve ? state.quoteReserve / state.baseReserve : null,
        source: "pumpswap",
      };
    },
    quoteExit(state, baseIn) {
      return {
        amountOut: cpmmOut(state.baseReserve, state.quoteReserve, baseIn, feeBps),
        source: "pumpswap",
      };
    },
    broadcast: broadcastBlocked("pumpswap"),
  };
}

/** Raydium-style computeAmountOut. simulateTransaction is local; broadcast throws. */
function raydiumAdapter(feeBps = 25) {
  return {
    name: "raydium",
    supports(state) {
      return !!(state && state.poolInfo && state.reserveIn != null && state.reserveOut != null);
    },
    quoteEntry(state, amountIn) {
      return {
        amountOut: cpmmOut(state.reserveIn, state.reserveOut, amountIn, feeBps),
        minOut: null,
        source: "raydium",
      };
    },
    quoteExit(state, amountIn) {
      return {
        amountOut: cpmmOut(state.reserveOut, state.reserveIn, amountIn, feeBps),
        source: "raydium",
      };
    },
    computeAmountOut(state, amountIn) {
      return this.quoteEntry(state, amountIn).amountOut;
    },
    simulate() {
      return { err: null, broadcast: false };
    },
    broadcast: broadcastBlocked("raydium"),
  };
}

/**
 * Jupiter is an injected quote cross-check. This module never calls the network
 * and never sends.
 */
function jupiterAdapter() {
  return {
    name: "jupiter",
    supports(quote) {
      return !!(quote && typeof quote.outAmount === "number");
    },
    quoteEntry(_state, quote) {
      return {
        amountOut: quote.outAmount,
        priceImpactPct: quote.priceImpactPct ?? null,
        source: "jupiter",
      };
    },
    quoteExit(_state, quote) {
      return { amountOut: quote.outAmount, source: "jupiter" };
    },
    broadcast: broadcastBlocked("jupiter"),
  };
}

function classifyVenue(input = {}) {
  if (input.venue) return input.venue;
  if (input.complete === true && input.poolProgram === "pumpswap") return "PUMPSWAP";
  if (input.complete === true && input.poolProgram === "raydium_cpmm") return "RAYDIUM_CPMM";
  if (input.complete === true && input.poolProgram === "raydium_amm") return "RAYDIUM_AMM";
  if (input.complete === true) return "OTHER";
  if (input.virtualSolReserves != null) return "PUMP_CURVE";
  return "UNKNOWN";
}

/**
 * Several valuations of the same round trip. Disagreement lowers confidence.
 * The reported pnl is the median, never the most favorable estimate.
 */
function combineValuations(estimates) {
  const usable = (estimates || []).filter((e) => e && typeof e.pnl === "number" && Number.isFinite(e.pnl));
  if (!usable.length) {
    return {
      pnl: null,
      mfe: null,
      mae: null,
      valuationSource: null,
      confidence: 0,
      missingReasons: ["no_valuation"],
    };
  }
  const pnls = usable.map((e) => e.pnl).sort((a, b) => a - b);
  const mid = pnls[Math.floor((pnls.length - 1) / 2)];
  let confidence = usable.length === 1 ? 0.6 : 0.85;
  const missingReasons = [];
  if (pnls.length >= 2) {
    const span = Math.abs(pnls[pnls.length - 1] - pnls[0]);
    if (span >= 15) {
      confidence *= 0.5;
      missingReasons.push("valuation_disagreement");
    }
  }
  const source = usable.length === 1 ? usable[0].source : "mixed";
  return {
    pnl: mid,
    mfe: usable.find((e) => typeof e.mfe === "number") ? usable.find((e) => typeof e.mfe === "number").mfe : null,
    mae: usable.find((e) => typeof e.mae === "number") ? usable.find((e) => typeof e.mae === "number").mae : null,
    valuationSource: source,
    confidence,
    missingReasons,
    sources: usable.map((e) => e.source),
  };
}

function highConfidence(outcome, min = 0.7) {
  return !!(outcome && typeof outcome.confidence === "number" && outcome.confidence >= min && outcome.pnl != null);
}

module.exports = {
  cpmmOut,
  pumpCurveAdapter,
  pumpSwapAdapter,
  raydiumAdapter,
  jupiterAdapter,
  classifyVenue,
  combineValuations,
  highConfidence,
  broadcastBlocked,
};
