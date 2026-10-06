/**
 * Pump bonding-curve dry-run math.
 *
 * Ported from:
 *   blablablasealsaresoft/chainstack-pumpfun-cli
 *     src/pumpfun_cli/protocol/curve.py
 *       calculate_buy_tokens_out, calculate_sell_sol_out,
 *       get_token_price_sol, get_bonding_progress, is_graduated
 *   Graduation threshold comment in that file: ~85 SOL real reserves.
 *
 * Integer division matches the Python floor-division. No transaction is built.
 */
"use strict";

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const GRADUATION_SOL = 85;

function calculateBuyTokensOut(state, solAmountLamports) {
  const solIn = Math.floor(solAmountLamports);
  const vTok = Math.floor(state.virtualTokenReserves);
  const vSol = Math.floor(state.virtualSolReserves);
  if (vTok <= 0 || vSol < 0 || solIn <= 0) return 0;
  return Math.floor((solIn * vTok) / (vSol + solIn));
}

function calculateSellSolOut(state, tokenAmount) {
  const tokens = Math.floor(tokenAmount);
  const vTok = Math.floor(state.virtualTokenReserves);
  const vSol = Math.floor(state.virtualSolReserves);
  if (vSol <= 0 || tokens <= 0) return 0;
  return Math.floor((tokens * vSol) / (vTok + tokens));
}

function getTokenPriceSol(state) {
  if (!state.virtualTokenReserves) return 0;
  return (
    (state.virtualSolReserves / state.virtualTokenReserves) *
    10 ** TOKEN_DECIMALS /
    LAMPORTS_PER_SOL
  );
}

function getBondingProgress(state) {
  const realSol = (state.realSolReserves || 0) / LAMPORTS_PER_SOL;
  return Math.min(realSol / GRADUATION_SOL, 1);
}

function isGraduated(state) {
  return state.complete === true || getBondingProgress(state) >= 1;
}

function curveFeatures(state, observedAt, source) {
  if (!state) return null;
  return {
    virtualSolReserves: state.virtualSolReserves ?? null,
    virtualTokenReserves: state.virtualTokenReserves ?? null,
    realSolReserves: state.realSolReserves ?? null,
    realTokenReserves: state.realTokenReserves ?? null,
    curveProgress: getBondingProgress(state),
    spotPrice: getTokenPriceSol(state),
    distanceToGraduation: Math.max(0, 1 - getBondingProgress(state)),
    observedAt: observedAt ?? null,
    source: source || "pump_curve",
  };
}

/**
 * Round-trip a buy then a sell on the curve. Returns percent PnL on the SOL in.
 * Applies the curve update so the sell sees post-buy reserves.
 */
function curveRoundTripPnlPct(state, solAmountLamports) {
  const tokens = calculateBuyTokensOut(state, solAmountLamports);
  if (!tokens) return null;
  const after = {
    ...state,
    virtualSolReserves: state.virtualSolReserves + solAmountLamports,
    virtualTokenReserves: state.virtualTokenReserves - tokens,
  };
  const solOut = calculateSellSolOut(after, tokens);
  return ((solOut - solAmountLamports) / solAmountLamports) * 100;
}

module.exports = {
  LAMPORTS_PER_SOL,
  TOKEN_DECIMALS,
  GRADUATION_SOL,
  calculateBuyTokensOut,
  calculateSellSolOut,
  getTokenPriceSol,
  getBondingProgress,
  isGraduated,
  curveFeatures,
  curveRoundTripPnlPct,
};
